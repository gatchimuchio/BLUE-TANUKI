#[cfg(not(windows))]
fn main() {
    eprintln!("windows_isolation_provider_requires_windows");
    std::process::exit(2);
}

#[cfg(windows)]
mod windows_provider {
    use std::ffi::{OsStr, OsString};
    use std::io::{self, BufRead};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        GRANT_ACCESS, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        FreeSid, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE,
        SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileAttributesW, ReadFile, FILE_ATTRIBUTE_REPARSE_POINT, FILE_GENERIC_EXECUTE,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };
    use windows_sys::Win32::System::Environment::{
        FreeEnvironmentStringsW, GetEnvironmentStringsW,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe as CreateAnonymousPipe;
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateProcessW, DeleteProcThreadAttributeList,
        InitializeProcThreadAttributeList, ResumeThread, SetEvent, TerminateProcess,
        UpdateProcThreadAttribute, WaitForMultipleObjects, WaitForSingleObject, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    const APP_CONTAINER_NAME: &str = "BlueTanukiShellExecWindowsV1";
    const MAX_ROOT_ENTRIES: usize = 100_000;
    const MAX_TIMEOUT_MS: u32 = 60_000;
    const MAX_OUTPUT_BYTES: usize = 512 * 1024;
    const PROCESS_MEMORY_LIMIT: usize = 512 * 1024 * 1024;
    const JOB_MEMORY_LIMIT: usize = 1024 * 1024 * 1024;
    const ACTIVE_PROCESS_LIMIT: u32 = 32;
    const TREE_SHUTDOWN_LIMIT: Duration = Duration::from_secs(5);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[derive(Debug)]
    struct Request {
        root: PathBuf,
        cwd: PathBuf,
        timeout_ms: u32,
        max_output_bytes: usize,
        command: OsString,
        args: Vec<OsString>,
    }

    #[derive(Default)]
    struct CapturedOutput {
        stdout: Vec<u8>,
        stderr: Vec<u8>,
        total_bytes: usize,
        truncated: bool,
    }

    struct Handle(HANDLE);

    unsafe impl Send for Handle {}

    impl Handle {
        fn new(handle: HANDLE, label: &str) -> Result<Self, String> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                Err(format!("windows_handle_create_failed:{label}:{}", unsafe {
                    GetLastError()
                }))
            } else {
                Ok(Self(handle))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    struct AppContainerSid(*mut core::ffi::c_void);

    impl Drop for AppContainerSid {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { FreeSid(self.0) };
            }
        }
    }

    struct AttributeList {
        ptr: *mut core::ffi::c_void,
        storage: Vec<usize>,
    }

    impl AttributeList {
        fn new(attributes: u32) -> Result<Self, String> {
            let mut bytes = 0usize;
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), attributes, 0, &mut bytes);
            }
            if bytes == 0 {
                return Err(last_error("attribute_list_size"));
            }
            let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
            let ptr = storage.as_mut_ptr().cast();
            if unsafe { InitializeProcThreadAttributeList(ptr, attributes, 0, &mut bytes) } == 0 {
                return Err(last_error("attribute_list_initialize"));
            }
            Ok(Self { ptr, storage })
        }

        fn update<T>(&mut self, key: u32, value: &T) -> Result<(), String> {
            if unsafe {
                UpdateProcThreadAttribute(
                    self.ptr,
                    0,
                    key as usize,
                    (value as *const T).cast(),
                    std::mem::size_of::<T>(),
                    null_mut(),
                    null(),
                )
            } == 0
            {
                Err(last_error("attribute_list_update"))
            } else {
                Ok(())
            }
        }
    }

    impl Drop for AttributeList {
        fn drop(&mut self) {
            if !self.ptr.is_null() {
                unsafe { DeleteProcThreadAttributeList(self.ptr) };
            }
            let _ = self.storage.len();
        }
    }

    struct TemporaryRootGrant {
        root: Vec<u16>,
        sid: *mut core::ffi::c_void,
        active: bool,
    }

    impl TemporaryRootGrant {
        fn apply(root: &Path, sid: &AppContainerSid) -> Result<Self, String> {
            let mut grant = Self {
                root: wide(root.as_os_str()),
                sid: sid.0,
                active: false,
            };
            grant.edit_acl(GRANT_ACCESS)?;
            grant.active = true;
            Ok(grant)
        }

        fn revoke(&mut self) -> Result<(), String> {
            if !self.active {
                return Ok(());
            }
            self.edit_acl(REVOKE_ACCESS)?;
            self.active = false;
            Ok(())
        }

        fn edit_acl(&self, mode: i32) -> Result<(), String> {
            let mut old_acl = null_mut();
            let mut security_descriptor = null_mut();
            let error = unsafe {
                GetNamedSecurityInfoW(
                    self.root.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut old_acl,
                    null_mut(),
                    &mut security_descriptor,
                )
            };
            if error != 0 {
                return Err(format!("windows_root_acl_read_failed:{error}"));
            }

            let trustee = TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: self.sid.cast(),
            };
            let entry = EXPLICIT_ACCESS_W {
                grfAccessPermissions: if mode == GRANT_ACCESS {
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE
                } else {
                    0
                },
                grfAccessMode: mode,
                grfInheritance: if mode == GRANT_ACCESS {
                    OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
                } else {
                    0
                },
                Trustee: trustee,
            };
            let mut updated_acl = null_mut();
            let error = unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut updated_acl) };
            if !security_descriptor.is_null() {
                unsafe { LocalFree(security_descriptor) };
            }
            if error != 0 {
                return Err(format!("windows_root_acl_prepare_failed:{error}"));
            }

            let error = unsafe {
                SetNamedSecurityInfoW(
                    self.root.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    updated_acl,
                    null_mut(),
                )
            };
            if !updated_acl.is_null() {
                unsafe { LocalFree(updated_acl.cast()) };
            }
            if error != 0 {
                return Err(format!("windows_root_acl_update_failed:{error}"));
            }
            Ok(())
        }
    }

    impl Drop for TemporaryRootGrant {
        fn drop(&mut self) {
            let _ = self.revoke();
        }
    }

    pub fn main() {
        match parse_request(std::env::args_os().skip(1)).and_then(|request| run(request)) {
            Ok(json) => {
                println!("{json}");
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
    }

    fn parse_request(mut args: impl Iterator<Item = OsString>) -> Result<Request, String> {
        let mut root = None;
        let mut cwd = None;
        let mut timeout_ms = None;
        let mut max_output_bytes = None;
        loop {
            let key = args
                .next()
                .ok_or_else(|| "windows_isolation_request_invalid".to_string())?;
            if key == OsStr::new("--") {
                break;
            }
            let value = args
                .next()
                .ok_or_else(|| "windows_isolation_request_invalid".to_string())?;
            match key.to_str() {
                Some("--root") => root = Some(PathBuf::from(value)),
                Some("--cwd") => cwd = Some(PathBuf::from(value)),
                Some("--timeout-ms") => timeout_ms = Some(parse_u32(&value, "timeout_ms")?),
                Some("--max-output-bytes") => {
                    max_output_bytes = Some(parse_usize(&value, "max_output_bytes")?)
                }
                _ => return Err("windows_isolation_request_invalid".to_string()),
            }
        }
        let command = args
            .next()
            .ok_or_else(|| "windows_isolation_command_invalid".to_string())?;
        let command_text = command
            .to_str()
            .ok_or_else(|| "windows_isolation_command_invalid".to_string())?;
        if command_text.is_empty()
            || command_text.contains('/')
            || command_text.contains('\\')
            || command_text.contains(':')
        {
            return Err("windows_isolation_command_invalid".to_string());
        }
        let args: Vec<OsString> = args.collect();
        if args.iter().any(|arg| arg.to_string_lossy().contains('\0')) {
            return Err("windows_isolation_arguments_invalid".to_string());
        }

        let timeout_ms = timeout_ms.unwrap_or(15_000);
        let max_output_bytes = max_output_bytes.unwrap_or(64_000);
        if timeout_ms == 0 || timeout_ms > MAX_TIMEOUT_MS {
            return Err("windows_isolation_timeout_invalid".to_string());
        }
        if max_output_bytes == 0 || max_output_bytes > MAX_OUTPUT_BYTES {
            return Err("windows_isolation_output_limit_invalid".to_string());
        }

        Ok(Request {
            root: root.ok_or_else(|| "windows_isolation_root_required".to_string())?,
            cwd: cwd.ok_or_else(|| "windows_isolation_cwd_required".to_string())?,
            timeout_ms,
            max_output_bytes,
            command,
            args,
        })
    }

    fn run(request: Request) -> Result<String, String> {
        let root = validate_root(&request.root)?;
        let cwd = validate_cwd(&request.cwd, &root)?;
        scan_root(&root)?;
        let command = resolve_command(&request.command)?;
        let sid = derive_app_container_sid()?;
        let mut root_grant = TemporaryRootGrant::apply(&root, &sid)?;

        let run_result = run_in_job(&request, &root, &cwd, &command, &sid);
        let cleanup_result = root_grant.revoke();
        match (run_result, cleanup_result) {
            (Ok(result), Ok(())) => Ok(result),
            (Err(run_error), Ok(())) => Err(run_error),
            (Ok(_), Err(cleanup_error)) => Err(cleanup_error),
            (Err(run_error), Err(cleanup_error)) => Err(format!(
                "windows_isolation_cleanup_failed:{run_error}:{cleanup_error}"
            )),
        }
    }

    fn validate_root(root: &Path) -> Result<PathBuf, String> {
        let root = root
            .canonicalize()
            .map_err(|_| "windows_isolation_root_unavailable".to_string())?;
        let metadata = std::fs::metadata(&root)
            .map_err(|_| "windows_isolation_root_unavailable".to_string())?;
        if !metadata.is_dir() || is_reparse_point(&root)? || root.parent().is_none() {
            return Err("windows_isolation_root_invalid".to_string());
        }
        if root
            .components()
            .any(|component| is_secret_component(&component.as_os_str().to_string_lossy()))
        {
            return Err("windows_isolation_root_contains_private_path".to_string());
        }
        Ok(root)
    }

    fn validate_cwd(cwd: &Path, root: &Path) -> Result<PathBuf, String> {
        let cwd = cwd
            .canonicalize()
            .map_err(|_| "windows_isolation_cwd_unavailable".to_string())?;
        if !cwd.is_dir() || !path_is_within(root, &cwd) || is_reparse_point(&cwd)? {
            return Err("windows_isolation_cwd_invalid".to_string());
        }
        let relative = cwd.strip_prefix(root).unwrap_or(Path::new("."));
        if is_secret_path(relative) {
            return Err("windows_isolation_cwd_private".to_string());
        }
        Ok(cwd)
    }

    fn scan_root(root: &Path) -> Result<(), String> {
        let mut visited = 0usize;
        scan_directory(root, root, 0, &mut visited)
    }

    fn scan_directory(
        root: &Path,
        current: &Path,
        depth: usize,
        visited: &mut usize,
    ) -> Result<(), String> {
        if depth > 64 {
            return Err("windows_isolation_root_scan_limit".to_string());
        }
        let entries = std::fs::read_dir(current)
            .map_err(|_| "windows_isolation_root_unreadable".to_string())?;
        for entry in entries {
            let entry = entry.map_err(|_| "windows_isolation_root_unreadable".to_string())?;
            *visited += 1;
            if *visited > MAX_ROOT_ENTRIES {
                return Err("windows_isolation_root_scan_limit".to_string());
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "windows_isolation_root_invalid".to_string())?;
            if is_secret_path(relative) {
                return Err("windows_isolation_root_contains_secret_like_path".to_string());
            }
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|_| "windows_isolation_root_unreadable".to_string())?;
            if metadata.file_type().is_symlink() || is_reparse_point(&path)? {
                return Err("windows_isolation_root_contains_reparse_point".to_string());
            }
            if metadata.is_dir() {
                scan_directory(root, &path, depth + 1, visited)?;
            }
        }
        Ok(())
    }

    fn is_secret_path(path: &Path) -> bool {
        path.components()
            .any(|component| is_secret_component(&component.as_os_str().to_string_lossy()))
    }

    fn is_secret_component(component: &str) -> bool {
        let lower = component.to_ascii_lowercase();
        matches!(
            lower.as_str(),
            ".aws"
                | ".azure"
                | ".env"
                | ".git"
                | ".gcloud"
                | ".netrc"
                | ".npmrc"
                | ".pypirc"
                | ".ssh"
                | "credentials"
                | "id_dsa"
                | "id_ecdsa"
                | "id_ed25519"
                | "id_rsa"
                | "secret"
                | "secrets"
                | "private-state"
        ) || lower.starts_with(".env.")
            || [".key", ".pem", ".p12", ".pfx"]
                .iter()
                .any(|suffix| lower.ends_with(suffix))
    }

    fn is_reparse_point(path: &Path) -> Result<bool, String> {
        let path = wide(path.as_os_str());
        let attributes = unsafe { GetFileAttributesW(path.as_ptr()) };
        if attributes == u32::MAX {
            return Err(format!("windows_path_inspection_failed:{}", unsafe {
                GetLastError()
            }));
        }
        Ok(attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }

    fn path_is_within(root: &Path, candidate: &Path) -> bool {
        candidate.starts_with(root)
    }

    fn resolve_command(command: &OsStr) -> Result<PathBuf, String> {
        let command_text = command
            .to_str()
            .ok_or_else(|| "windows_isolation_command_invalid".to_string())?;
        if command_text.is_empty()
            || command_text.contains('/')
            || command_text.contains('\\')
            || command_text.contains(':')
        {
            return Err("windows_isolation_command_invalid".to_string());
        }
        let path = std::env::var_os("PATH")
            .ok_or_else(|| "windows_isolation_path_unavailable".to_string())?;
        let mut candidates = Vec::new();
        let has_extension = Path::new(command).extension().is_some();
        for directory in std::env::split_paths(&path).filter(|part| !part.as_os_str().is_empty()) {
            if has_extension {
                candidates.push(directory.join(command));
            } else {
                candidates.push(directory.join(format!("{command_text}.exe")));
                candidates.push(directory.join(format!("{command_text}.com")));
            }
        }
        for candidate in candidates {
            if candidate.extension().is_some_and(|ext| {
                !ext.eq_ignore_ascii_case("exe") && !ext.eq_ignore_ascii_case("com")
            }) {
                continue;
            }
            if candidate.is_file() {
                let canonical = candidate
                    .canonicalize()
                    .map_err(|_| "windows_isolation_command_unavailable".to_string())?;
                return Ok(win32_path(&canonical));
            }
        }
        Err("windows_isolation_command_unavailable".to_string())
    }

    fn derive_app_container_sid() -> Result<AppContainerSid, String> {
        let name = wide(OsStr::new(APP_CONTAINER_NAME));
        let mut sid = null_mut();
        let display = wide(OsStr::new("BLUE-TANUKI shell execution"));
        let description = wide(OsStr::new(
            "Windows AppContainer for bounded shell execution",
        ));
        let result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                display.as_ptr(),
                description.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result == 0 && !sid.is_null() {
            return Ok(AppContainerSid(sid));
        }
        if result != (0x8007_00B7u32 as i32) {
            return Err(format!("windows_appcontainer_profile_unavailable:{result}"));
        }
        let result = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
        if result < 0 || sid.is_null() {
            return Err(format!("windows_appcontainer_sid_unavailable:{result}"));
        }
        Ok(AppContainerSid(sid))
    }

    fn run_in_job(
        request: &Request,
        root: &Path,
        cwd: &Path,
        command: &Path,
        sid: &AppContainerSid,
    ) -> Result<String, String> {
        let job = Handle::new(unsafe { CreateJobObjectW(null(), null()) }, "job")?;
        configure_job(job.raw())?;
        let cancel_event = Handle::new(create_event(), "cancel_event")?;

        let mut stdout_read = null_mut();
        let mut stdout_write = null_mut();
        let mut stderr_read = null_mut();
        let mut stderr_write = null_mut();
        let security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        if unsafe { CreateAnonymousPipe(&mut stdout_read, &mut stdout_write, &security, 0) } == 0
            || unsafe { CreateAnonymousPipe(&mut stderr_read, &mut stderr_write, &security, 0) }
                == 0
        {
            close_raw(stdout_read);
            close_raw(stdout_write);
            close_raw(stderr_read);
            close_raw(stderr_write);
            return Err(last_error("output_pipe_create"));
        }
        let stdout_read = Handle::new(stdout_read, "stdout_read")?;
        let stdout_write = Handle::new(stdout_write, "stdout_write")?;
        let stderr_read = Handle::new(stderr_read, "stderr_read")?;
        let stderr_write = Handle::new(stderr_write, "stderr_write")?;
        if unsafe { SetHandleInformation(stdout_read.raw(), HANDLE_FLAG_INHERIT, 0) } == 0
            || unsafe { SetHandleInformation(stderr_read.raw(), HANDLE_FLAG_INHERIT, 0) } == 0
        {
            return Err(last_error("output_pipe_configure"));
        }

        let stdin_handle = Handle::new(open_nul(), "stdin")?;
        if unsafe {
            SetHandleInformation(stdin_handle.raw(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
        } == 0
        {
            return Err(last_error("stdin_handle_configure"));
        }
        let inherited = [stdin_handle.raw(), stdout_write.raw(), stderr_write.raw()];
        let mut attributes = AttributeList::new(2)?;
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: sid.0,
            Capabilities: null_mut::<SID_AND_ATTRIBUTES>(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        attributes.update(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities)?;
        if unsafe {
            UpdateProcThreadAttribute(
                attributes.ptr,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited.as_ptr().cast(),
                std::mem::size_of_val(&inherited),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error("handle_list_update"));
        }

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin_handle.raw();
        startup.StartupInfo.hStdOutput = stdout_write.raw();
        startup.StartupInfo.hStdError = stderr_write.raw();
        startup.lpAttributeList = attributes.ptr.cast();

        let mut command_line = command_line(command, &request.args);
        let mut environment = environment_block(root, cwd)?;
        let current_directory = wide(win32_path(cwd).as_os_str());
        let application_name = wide(command.as_os_str());
        let mut process_info = PROCESS_INFORMATION::default();
        let created = unsafe {
            CreateProcessW(
                application_name.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_NO_WINDOW,
                environment.as_mut_ptr().cast(),
                current_directory.as_ptr(),
                (&startup as *const STARTUPINFOEXW).cast(),
                &mut process_info,
            )
        };
        if created == 0 {
            return Err(last_error("appcontainer_process_create"));
        }
        let process = Handle::new(process_info.hProcess, "process")?;
        let thread_handle = match Handle::new(process_info.hThread, "primary_thread") {
            Ok(handle) => handle,
            Err(error) => {
                unsafe { TerminateProcess(process.raw(), 0xC000_013A) };
                unsafe {
                    WaitForSingleObject(process.raw(), TREE_SHUTDOWN_LIMIT.as_millis() as u32)
                };
                return Err(error);
            }
        };

        if unsafe { AssignProcessToJobObject(job.raw(), process.raw()) } == 0 {
            let error = last_error("process_job_assignment");
            unsafe { TerminateProcess(process.raw(), 0xC000_013A) };
            if unsafe { WaitForSingleObject(process.raw(), TREE_SHUTDOWN_LIMIT.as_millis() as u32) }
                != WAIT_OBJECT_0
            {
                return Err("windows_process_start_shutdown_unconfirmed".to_string());
            }
            return Err(error);
        }
        if unsafe { ResumeThread(thread_handle.raw()) } == u32::MAX {
            unsafe { TerminateJobObject(job.raw(), 0xC000_013A) };
            let error = last_error("process_resume");
            if unsafe { WaitForSingleObject(process.raw(), TREE_SHUTDOWN_LIMIT.as_millis() as u32) }
                != WAIT_OBJECT_0
            {
                return Err("windows_process_start_shutdown_unconfirmed".to_string());
            }
            wait_for_empty_job(job.raw())?;
            return Err(error);
        }
        drop(thread_handle);
        drop(stdout_write);
        drop(stderr_write);
        drop(stdin_handle);

        let output = Arc::new(Mutex::new(CapturedOutput::default()));
        let stdout_thread = spawn_reader(
            stdout_read,
            Arc::clone(&output),
            true,
            request.max_output_bytes,
        );
        let stderr_thread = spawn_reader(
            stderr_read,
            Arc::clone(&output),
            false,
            request.max_output_bytes,
        );
        thread::spawn({
            let event = cancel_event.raw() as usize;
            move || {
                let mut line = String::new();
                if io::stdin().lock().read_line(&mut line).is_ok() && line.trim() == "cancel" {
                    unsafe { SetEvent(event as HANDLE) };
                }
            }
        });

        let wait_handles = [process.raw(), cancel_event.raw()];
        let wait = unsafe {
            WaitForMultipleObjects(
                wait_handles.len() as u32,
                wait_handles.as_ptr(),
                0,
                request.timeout_ms,
            )
        };
        let (signal, timed_out) = if wait == WAIT_OBJECT_0 {
            (None, false)
        } else if wait == WAIT_OBJECT_0 + 1 {
            (Some("aborted"), true)
        } else if wait == WAIT_TIMEOUT {
            (Some("timeout"), true)
        } else {
            unsafe { TerminateJobObject(job.raw(), 0xC000_013A) };
            return Err(last_error("process_wait"));
        };

        let mut descendants_terminated = false;
        if signal.is_some() || active_processes(job.raw())? > 0 {
            descendants_terminated = signal.is_none();
            unsafe { TerminateJobObject(job.raw(), 0xC000_013A) };
            if unsafe { WaitForSingleObject(process.raw(), TREE_SHUTDOWN_LIMIT.as_millis() as u32) }
                != WAIT_OBJECT_0
            {
                return Err("windows_process_tree_shutdown_unconfirmed".to_string());
            }
        }
        wait_for_empty_job(job.raw())?;

        let exit_code = if signal.is_some() {
            None
        } else {
            let mut code = 0u32;
            if unsafe {
                windows_sys::Win32::System::Threading::GetExitCodeProcess(process.raw(), &mut code)
            } == 0
            {
                return Err(last_error("process_exit_code"));
            }
            Some(code)
        };

        let stdout_thread = stdout_thread
            .join()
            .map_err(|_| "windows_stdout_capture_failed".to_string())?;
        let stderr_thread = stderr_thread
            .join()
            .map_err(|_| "windows_stderr_capture_failed".to_string())?;
        if stdout_thread.is_err() || stderr_thread.is_err() {
            return Err("windows_output_capture_failed".to_string());
        }
        let output = output
            .lock()
            .map_err(|_| "windows_output_capture_failed".to_string())?;
        let signal_json = signal
            .map(json_string)
            .unwrap_or_else(|| "null".to_string());
        let exit_json = exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "null".to_string());
        let stdout = json_string(&String::from_utf8_lossy(&output.stdout));
        let stderr = json_string(&String::from_utf8_lossy(&output.stderr));
        Ok(format!(
            "{{\"exit_code\":{exit_json},\"signal\":{signal_json},\"timed_out\":{timed_out},\"stdout\":{stdout},\"stderr\":{stderr},\"truncated\":{},\"process_tree_empty\":true,\"descendants_terminated\":{descendants_terminated}}}",
            output.truncated
        ))
    }

    fn configure_job(job: HANDLE) -> Result<(), String> {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = ACTIVE_PROCESS_LIMIT;
        limits.ProcessMemoryLimit = PROCESS_MEMORY_LIMIT;
        limits.JobMemoryLimit = JOB_MEMORY_LIMIT;
        if unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            Err(last_error("job_limits_configure"))
        } else {
            Ok(())
        }
    }

    fn active_processes(job: HANDLE) -> Result<u32, String> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let mut returned = 0u32;
        if unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                &mut returned,
            )
        } == 0
        {
            Err(last_error("job_process_count"))
        } else {
            Ok(accounting.ActiveProcesses)
        }
    }

    fn wait_for_empty_job(job: HANDLE) -> Result<(), String> {
        let deadline = Instant::now() + TREE_SHUTDOWN_LIMIT;
        loop {
            if active_processes(job)? == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("windows_process_tree_shutdown_unconfirmed".to_string());
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn spawn_reader(
        handle: Handle,
        output: Arc<Mutex<CapturedOutput>>,
        stdout: bool,
        max_bytes: usize,
    ) -> thread::JoinHandle<Result<(), ()>> {
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                let mut read = 0u32;
                let succeeded = unsafe {
                    ReadFile(
                        handle.raw(),
                        buffer.as_mut_ptr(),
                        buffer.len() as u32,
                        &mut read,
                        null_mut(),
                    )
                };
                if succeeded == 0 {
                    let error = unsafe { GetLastError() };
                    if error == 109 {
                        return Ok(());
                    }
                    return Err(());
                }
                if read == 0 {
                    return Ok(());
                }
                let mut capture = output.lock().map_err(|_| ())?;
                let remaining = max_bytes.saturating_sub(capture.total_bytes);
                let keep = remaining.min(read as usize);
                let destination = if stdout {
                    &mut capture.stdout
                } else {
                    &mut capture.stderr
                };
                destination.extend_from_slice(&buffer[..keep]);
                capture.total_bytes += keep;
                if keep < read as usize {
                    capture.truncated = true;
                }
            }
        })
    }

    fn environment_block(root: &Path, cwd: &Path) -> Result<Vec<u16>, String> {
        const ALLOWED_KEYS: [&str; 31] = [
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "PROMPT",
            "SYSTEMDRIVE",
            "HOMEDRIVE",
            "HOMEPATH",
            "USERNAME",
            "USERDOMAIN",
            "LOGONSERVER",
            "OS",
            "ALLUSERSPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "PROGRAMW6432",
            "COMMONPROGRAMFILES",
            "COMMONPROGRAMFILES(X86)",
            "COMMONPROGRAMW6432",
            "PUBLIC",
            "COMPUTERNAME",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
            "PROCESSOR_IDENTIFIER",
            "PROCESSOR_LEVEL",
            "PROCESSOR_REVISION",
            "DRIVERDATA",
        ];
        let source = unsafe { GetEnvironmentStringsW() };
        if source.is_null() {
            return Err(last_error("environment_read"));
        }
        let mut values: Vec<(String, Vec<u16>)> = Vec::new();
        let mut current = source;
        unsafe {
            while *current != 0 {
                let start = current;
                while *current != 0 {
                    current = current.add(1);
                }
                let length = current.offset_from(start) as usize;
                if length > 0 {
                    let entry = std::slice::from_raw_parts(start, length);
                    let delimiter = if entry[0] == '=' as u16 {
                        entry
                            .iter()
                            .skip(1)
                            .position(|unit| *unit == '=' as u16)
                            .map(|index| index + 1)
                    } else {
                        entry.iter().position(|unit| *unit == '=' as u16)
                    };
                    if let Some(key_length) = delimiter {
                        let key = String::from_utf16_lossy(&entry[..key_length]);
                        if !key.starts_with('=')
                            && ALLOWED_KEYS
                                .iter()
                                .any(|allowed| key.eq_ignore_ascii_case(allowed))
                            && !values
                                .iter()
                                .any(|(existing, _)| existing.eq_ignore_ascii_case(&key))
                        {
                            values.push((key, entry[key_length + 1..].to_vec()));
                        }
                    }
                }
                current = current.add(1);
            }
            FreeEnvironmentStringsW(source);
        }

        let root_path = win32_path(root);
        let cwd_path = win32_path(cwd);
        let root_units = root_path.as_os_str().encode_wide().collect::<Vec<_>>();
        let cwd_units = cwd_path.as_os_str().encode_wide().collect::<Vec<_>>();
        if root_units.len() < 3 || root_units[1] != ':' as u16 || cwd_units.len() < 2 {
            return Err("windows_isolation_environment_drive_invalid".to_string());
        }
        let drive = (root_units[0] as u8 as char).to_ascii_uppercase();
        let drive_text = format!("{drive}:");
        let system_root_present = values
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("SYSTEMROOT"));
        if !system_root_present {
            return Err("windows_system_root_unavailable".to_string());
        }

        set_environment_value(&mut values, "TEMP", &root_units);
        set_environment_value(&mut values, "TMP", &root_units);
        set_environment_value(&mut values, "HOME", &root_units);
        set_environment_value(&mut values, "USERPROFILE", &root_units);
        for name in [
            "APPDATA",
            "LOCALAPPDATA",
            "ALLUSERSPROFILE",
            "PROGRAMDATA",
            "PUBLIC",
        ] {
            set_environment_value(&mut values, name, &root_units);
        }
        set_environment_value(
            &mut values,
            "SYSTEMDRIVE",
            &drive_text.encode_utf16().collect::<Vec<_>>(),
        );
        set_environment_value(
            &mut values,
            "HOMEDRIVE",
            &drive_text.encode_utf16().collect::<Vec<_>>(),
        );
        set_environment_value(&mut values, "HOMEPATH", &root_units[2..]);
        set_environment_value(
            &mut values,
            "USERNAME",
            &"BLUE-TANUKI".encode_utf16().collect::<Vec<_>>(),
        );
        set_environment_value(
            &mut values,
            "USERDOMAIN",
            &"LOCAL".encode_utf16().collect::<Vec<_>>(),
        );
        let drive_key = format!("={drive}:");
        set_environment_value(&mut values, &drive_key, &cwd_units);
        values.sort_by(|left, right| {
            left.0
                .to_ascii_uppercase()
                .cmp(&right.0.to_ascii_uppercase())
        });

        let mut block = Vec::new();
        for (key, value) in values {
            block.extend(OsStr::new(&key).encode_wide());
            block.push('=' as u16);
            block.extend(value);
            block.push(0);
        }
        block.push(0);
        Ok(block)
    }

    fn set_environment_value(values: &mut Vec<(String, Vec<u16>)>, key: &str, value: &[u16]) {
        if let Some(existing) = values
            .iter_mut()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(key))
        {
            existing.1.clear();
            existing.1.extend_from_slice(value);
        } else {
            values.push((key.to_string(), value.to_vec()));
        }
    }

    fn command_line(command: &Path, args: &[OsString]) -> Vec<u16> {
        let command = win32_path(command);
        let mut units =
            quote_windows_argument(&command.as_os_str().encode_wide().collect::<Vec<_>>());
        for arg in args {
            units.push(' ' as u16);
            units.extend(quote_windows_argument(
                &arg.encode_wide().collect::<Vec<_>>(),
            ));
        }
        units.push(0);
        units
    }

    fn quote_windows_argument(argument: &[u16]) -> Vec<u16> {
        let needs_quotes = argument.is_empty()
            || argument
                .iter()
                .any(|unit| *unit == ' ' as u16 || *unit == '\t' as u16 || *unit == '"' as u16);
        if !needs_quotes {
            return argument.to_vec();
        }
        let mut quoted = vec!['"' as u16];
        let mut backslashes = 0usize;
        for unit in argument {
            if *unit == '\\' as u16 {
                backslashes += 1;
            } else if *unit == '"' as u16 {
                quoted.extend(std::iter::repeat('\\' as u16).take(backslashes * 2 + 1));
                quoted.push(*unit);
                backslashes = 0;
            } else {
                quoted.extend(std::iter::repeat('\\' as u16).take(backslashes));
                quoted.push(*unit);
                backslashes = 0;
            }
        }
        quoted.extend(std::iter::repeat('\\' as u16).take(backslashes * 2));
        quoted.push('"' as u16);
        quoted
    }

    fn open_nul() -> HANDLE {
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };
        let name = wide(OsStr::new("NUL"));
        unsafe {
            CreateFileW(
                name.as_ptr(),
                0x8000_0000,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        }
    }

    fn create_event() -> HANDLE {
        unsafe { CreateEventW(null(), 1, 0, null()) }
    }

    fn close_raw(handle: HANDLE) {
        if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(handle) };
        }
    }

    fn parse_u32(value: &OsStr, name: &str) -> Result<u32, String> {
        value
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| format!("windows_isolation_{name}_invalid"))
    }

    fn parse_usize(value: &OsStr, name: &str) -> Result<usize, String> {
        value
            .to_str()
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(|| format!("windows_isolation_{name}_invalid"))
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn win32_path(path: &Path) -> PathBuf {
        let value = path.as_os_str().to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{rest}"))
        } else if let Some(rest) = value.strip_prefix(r"\\?\") {
            PathBuf::from(rest)
        } else {
            path.to_path_buf()
        }
    }

    fn json_string(value: &str) -> String {
        let mut json = String::with_capacity(value.len() + 2);
        json.push('"');
        for character in value.chars() {
            match character {
                '"' => json.push_str("\\\""),
                '\\' => json.push_str("\\\\"),
                '\n' => json.push_str("\\n"),
                '\r' => json.push_str("\\r"),
                '\t' => json.push_str("\\t"),
                character if character < ' ' => {
                    json.push_str(&format!("\\u{:04x}", character as u32));
                }
                character => json.push(character),
            }
        }
        json.push('"');
        json
    }

    fn last_error(context: &str) -> String {
        format!("{context}:{}", unsafe { GetLastError() })
    }
}

#[cfg(windows)]
fn main() {
    windows_provider::main();
}
