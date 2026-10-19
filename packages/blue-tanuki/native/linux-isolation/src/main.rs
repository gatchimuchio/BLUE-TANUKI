use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

mod workspace_quota;

const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ROOT_ENTRIES: usize = 100_000;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TASKS: &str = "64";
const MEMORY_MAX: &str = "512M";
const CPU_QUOTA: &str = "100%";
const TREE_SHUTDOWN_LIMIT: Duration = Duration::from_secs(5);
const RESULT_MAGIC: &[u8] = b"BT-LINUX-ISOLATION/1\n";

#[derive(Debug)]
struct Request {
    root: PathBuf,
    cwd: PathBuf,
    timeout_ms: u64,
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

struct InnerResult {
    exit_code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
    descendants_seen: bool,
}

struct UnitState {
    result: String,
    exec_main_status: String,
    control_group: String,
    active_state: String,
}

fn main() {
    let result = std::panic::catch_unwind(run);
    match result {
        Ok(Ok(Some(json))) => {
            println!("{json}");
        }
        Ok(Ok(None)) => {}
        Ok(Err(error)) => {
            eprintln!("linux_isolation_error:{}", stable_error(&error));
            std::process::exit(2);
        }
        Err(_) => {
            eprintln!("linux_isolation_error:provider_panic");
            std::process::exit(2);
        }
    }
}

fn run() -> Result<Option<String>, String> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().map(|arg| arg == "--inner").unwrap_or(false) {
        let request = parse_inner(args.into_iter().skip(1).collect())?;
        let result = run_inner(request)?;
        write_inner_frame(&result)?;
        return Ok(None);
    }
    if args
        .first()
        .map(|arg| arg == "--command-inner")
        .unwrap_or(false)
    {
        let request = parse_inner(args.into_iter().skip(1).collect())?;
        let result = run_command_inner(request)?;
        write_inner_frame(&result)?;
        return Ok(None);
    }

    let request = parse_outer(args)?;
    let result = run_outer(request)?;
    Ok(Some(result))
}

fn parse_outer(args: Vec<OsString>) -> Result<Request, String> {
    let mut root = None;
    let mut cwd = None;
    let mut timeout_ms = 15_000u64;
    let mut max_output_bytes = 64_000usize;
    let mut command = None;
    let mut command_args = Vec::new();
    let mut index = 0usize;

    while index < args.len() {
        let arg = args[index].to_string_lossy();
        match arg.as_ref() {
            "--root" | "--cwd" | "--timeout-ms" | "--max-output-bytes" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| "invalid_request".to_string())?;
                match arg.as_ref() {
                    "--root" => root = Some(PathBuf::from(value)),
                    "--cwd" => cwd = Some(PathBuf::from(value)),
                    "--timeout-ms" => {
                        timeout_ms = parse_bounded_u64(value, 1, MAX_TIMEOUT_MS)?;
                    }
                    "--max-output-bytes" => {
                        max_output_bytes = parse_bounded_usize(value, 1, MAX_OUTPUT_BYTES)?;
                    }
                    _ => unreachable!(),
                }
            }
            "--" => {
                index += 1;
                command = args.get(index).cloned();
                if command.is_none() {
                    return Err("invalid_request".to_string());
                }
                command_args.extend(args[index + 1..].iter().cloned());
                break;
            }
            _ => return Err("invalid_request".to_string()),
        }
        index += 1;
    }

    let raw_root = root.ok_or_else(|| "invalid_request".to_string())?;
    let root = fs::canonicalize(raw_root).map_err(|_| "shell_root_unavailable".to_string())?;
    let root_metadata = fs::metadata(&root).map_err(|_| "shell_root_unavailable".to_string())?;
    if !root_metadata.is_dir() || is_secret_path(&root) {
        return Err("unsafe_shell_root".to_string());
    }
    inspect_root(&root)?;

    let raw_cwd = cwd.unwrap_or_else(|| PathBuf::from("."));
    let lexical_cwd = if raw_cwd.is_absolute() {
        raw_cwd
    } else {
        root.join(raw_cwd)
    };
    let cwd = fs::canonicalize(lexical_cwd).map_err(|_| "shell_cwd_unavailable".to_string())?;
    if !cwd.starts_with(&root) || !fs::metadata(&cwd).map(|m| m.is_dir()).unwrap_or(false) {
        return Err("unsafe_shell_cwd".to_string());
    }
    if is_secret_path(&cwd) || has_secret_relative_component(&root, &cwd) {
        return Err("unsafe_shell_cwd".to_string());
    }

    let command = command.ok_or_else(|| "invalid_request".to_string())?;
    validate_command(&command, &command_args)?;

    Ok(Request {
        root,
        cwd,
        timeout_ms,
        max_output_bytes,
        command,
        args: command_args,
    })
}

fn parse_inner(args: Vec<OsString>) -> Result<InnerRequest, String> {
    let mut namespaces = BTreeMap::new();
    let mut cwd = None;
    let mut command = None;
    let mut command_args = Vec::new();
    let mut index = 0usize;
    while index < args.len() {
        let arg = args[index].to_string_lossy();
        if arg == "--" {
            index += 1;
            command = args.get(index).cloned();
            if command.is_none() {
                return Err("invalid_inner_request".to_string());
            }
            command_args.extend(args[index + 1..].iter().cloned());
            break;
        }
        if arg == "--cwd" {
            index += 1;
            let value = args
                .get(index)
                .ok_or_else(|| "invalid_inner_request".to_string())?;
            let parsed = PathBuf::from(value);
            if !parsed.is_absolute()
                || !parsed.starts_with("/workspace")
                || parsed
                    .components()
                    .any(|component| component == Component::ParentDir)
            {
                return Err("invalid_inner_request".to_string());
            }
            cwd = Some(parsed);
        } else {
            let (key, value) = arg
                .strip_prefix("--expect-")
                .and_then(|key| key.split_once('='))
                .ok_or_else(|| "invalid_inner_request".to_string())?;
            let parsed = value
                .parse::<u64>()
                .map_err(|_| "invalid_inner_request".to_string())?;
            if !matches!(key, "user" | "mnt" | "pid" | "net" | "ipc" | "uts") {
                return Err("invalid_inner_request".to_string());
            }
            namespaces.insert(key.to_string(), parsed);
        }
        index += 1;
    }
    if namespaces.len() != 6 || cwd.is_none() {
        return Err("invalid_inner_request".to_string());
    }
    let command = command.ok_or_else(|| "invalid_inner_request".to_string())?;
    validate_command(&command, &command_args)?;
    Ok(InnerRequest {
        namespaces,
        cwd: cwd.ok_or_else(|| "invalid_inner_request".to_string())?,
        command,
        args: command_args,
    })
}

struct InnerRequest {
    namespaces: BTreeMap<String, u64>,
    cwd: PathBuf,
    command: OsString,
    args: Vec<OsString>,
}

fn run_outer(request: Request) -> Result<String, String> {
    ensure_runtime_prerequisites()?;
    let helper = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|_| "provider_path_unavailable".to_string())?;
    if helper.starts_with(&request.root) {
        return Err("provider_inside_shell_root".to_string());
    }
    let host_namespaces = namespace_ids()?;
    let unit = format!(
        "blue-tanuki-shell-{}-{}.service",
        std::process::id(),
        read_uuid()?
    );
    let runtime = format!("{}ms", request.timeout_ms);
    let cwd_relative = request
        .cwd
        .strip_prefix(&request.root)
        .map_err(|_| "unsafe_shell_cwd".to_string())?;
    let sandbox_cwd = if cwd_relative.as_os_str().is_empty() {
        "/workspace".to_string()
    } else {
        format!("/workspace/{}", cwd_relative.to_string_lossy())
    };

    let bwrap = Path::new("/usr/bin/bwrap");
    let mut bwrap_args: Vec<OsString> = vec![
        "--unshare-user".into(),
        "--unshare-pid".into(),
        "--unshare-net".into(),
        "--unshare-ipc".into(),
        "--unshare-uts".into(),
        "--new-session".into(),
        "--die-with-parent".into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--cap-add".into(),
        "CAP_SYS_ADMIN".into(),
        "--ro-bind".into(),
        "/usr".into(),
        "/usr".into(),
    ];
    for (source, destination) in [
        ("usr/bin", "/bin"),
        ("usr/sbin", "/sbin"),
        ("usr/lib", "/lib"),
        ("usr/lib64", "/lib64"),
    ] {
        let source_path = Path::new("/usr").join(source.strip_prefix("usr/").unwrap_or(source));
        if source_path.exists() {
            bwrap_args.extend(["--symlink".into(), source.into(), destination.into()]);
        }
    }
    bwrap_args.extend([
        "--proc".into(),
        "/proc".into(),
        "--dev".into(),
        "/dev".into(),
        "--size".into(),
        MAX_FILE_BYTES.to_string().into(),
        "--perms".into(),
        "1777".into(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--dir".into(),
        "/workspace".into(),
        "--dir".into(),
        "/workspace-lower".into(),
        "--ro-bind".into(),
        request.root.as_os_str().to_owned(),
        "/workspace-lower".into(),
        "--dir".into(),
        "/workspace-storage".into(),
        "--dir".into(),
        "/commit-target".into(),
        "--bind".into(),
        request.root.as_os_str().to_owned(),
        "/commit-target".into(),
        "--ro-bind".into(),
        helper.as_os_str().to_owned(),
        "/bt-linux-isolation-helper".into(),
        "--chdir".into(),
        "/".into(),
        "--clearenv".into(),
        "--setenv".into(),
        "PATH".into(),
        "/usr/bin:/bin".into(),
        "--setenv".into(),
        "HOME".into(),
        "/workspace".into(),
        "--setenv".into(),
        "TMPDIR".into(),
        "/tmp".into(),
        "--setenv".into(),
        "LANG".into(),
        "C.UTF-8".into(),
        "--setenv".into(),
        "BT_MAX_OUTPUT_BYTES".into(),
        request.max_output_bytes.to_string().into(),
        "--".into(),
        "/bt-linux-isolation-helper".into(),
        "--inner".into(),
        "--cwd".into(),
        sandbox_cwd.into(),
    ]);
    for (name, inode) in host_namespaces.iter() {
        bwrap_args.push(format!("--expect-{name}={inode}").into());
    }
    bwrap_args.push("--".into());
    bwrap_args.push(request.command.clone());
    bwrap_args.extend(request.args.iter().cloned());

    let uid = unsafe { libc::geteuid() };
    let runtime_dir = format!("/run/user/{uid}");
    let mut systemd = Command::new("/usr/bin/systemd-run");
    systemd
        .args([
            "--user",
            "--pipe",
            "--wait",
            "--quiet",
            "--unit",
            &unit,
            "--property=KillMode=control-group",
            "--property=TimeoutStopSec=2s",
            "--property=LimitCORE=0",
            "--property=LimitNOFILE=128",
            &format!(
                "--property=LimitFSIZE={}",
                workspace_quota::MAX_WORKSPACE_BYTES
            ),
            &format!("--property=MemoryMax={MEMORY_MAX}"),
            &format!("--property=TasksMax={MAX_TASKS}"),
            &format!("--property=CPUQuota={CPU_QUOTA}"),
            &format!("--property=RuntimeMaxSec={runtime}"),
            "--",
            bwrap
                .to_str()
                .ok_or_else(|| "provider_path_unavailable".to_string())?,
        ])
        .args(bwrap_args.iter())
        .current_dir("/")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("XDG_RUNTIME_DIR", &runtime_dir)
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={runtime_dir}/bus"),
        )
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = systemd
        .spawn()
        .map_err(|_| "systemd_run_unavailable".to_string())?;
    let child_pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "systemd_output_unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "systemd_output_unavailable".to_string())?;
    let output = Arc::new(Mutex::new(CapturedOutput::default()));
    let stdout_thread = spawn_reader(stdout, Arc::clone(&output), true, MAX_RESPONSE_BYTES);
    let stderr_thread = spawn_reader(stderr, Arc::clone(&output), false, MAX_RESPONSE_BYTES);

    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_flag = Arc::clone(&cancelled);
    let unit_for_cancel = unit.clone();
    let runtime_dir_for_cancel = runtime_dir.clone();
    thread::spawn(move || {
        let mut line = String::new();
        if io::stdin().lock().read_line(&mut line).is_ok() && line.trim() == "cancel" {
            cancel_flag.store(true, Ordering::SeqCst);
            let _ = systemctl_user(
                &runtime_dir_for_cancel,
                &["stop".to_string(), unit_for_cancel],
            );
        }
    });

    let status = child
        .wait()
        .map_err(|_| "systemd_wait_failed".to_string())?;
    let stdout_thread = stdout_thread
        .join()
        .map_err(|_| "linux_output_capture_failed".to_string())?;
    let stderr_thread = stderr_thread
        .join()
        .map_err(|_| "linux_output_capture_failed".to_string())?;
    if stdout_thread.is_err() || stderr_thread.is_err() {
        return Err("linux_output_capture_failed".to_string());
    }
    let captured = output
        .lock()
        .map_err(|_| "linux_output_capture_failed".to_string())?;
    if captured.truncated {
        return Err("linux_provider_response_exceeded_bound".to_string());
    }
    let unit_state = query_unit(&runtime_dir, &unit)?;
    let tree_empty = verify_unit_tree_empty(&unit_state, uid)?;
    if !tree_empty {
        let _ = systemctl_user(&runtime_dir, &["stop".into(), unit.clone()]);
        return Err("linux_process_tree_shutdown_unconfirmed".to_string());
    }
    let _ = systemctl_user(&runtime_dir, &["reset-failed".into(), unit.clone()]);

    let response = if cancelled.load(Ordering::SeqCst) {
        result_json(None, Some("aborted"), true, "", "", false, true, false)
    } else if unit_state.result == "timeout" {
        result_json(None, Some("timeout"), true, "", "", false, true, false)
    } else if unit_state.result != "success"
        || unit_state.exec_main_status != "0"
        || !status.success()
    {
        let diagnostic = safe_diagnostic(&captured.stderr);
        return Err(if diagnostic.is_empty() {
            "linux_sandbox_start_or_shutdown_failed".to_string()
        } else {
            format!("linux_sandbox_start_or_shutdown_failed:{diagnostic}")
        });
    } else {
        let frame = parse_inner_frame(&captured.stdout)?;
        let stdout = String::from_utf8_lossy(&frame.stdout);
        let stderr = String::from_utf8_lossy(&frame.stderr);
        result_json(
            Some(frame.exit_code),
            None,
            false,
            &stdout,
            &stderr,
            frame.truncated,
            true,
            frame.descendants_seen,
        )
    };
    let _ = child_pid;
    Ok(response)
}

fn run_inner(request: InnerRequest) -> Result<InnerResult, String> {
    verify_outer_isolation(&request.namespaces)?;
    let commit_root = Path::new("/commit-target");
    inspect_root(commit_root)?;
    let baseline = workspace_quota::snapshot_tree(commit_root)?;
    workspace_quota::mount_bounded_overlay()?;
    set_dumpable(false)?;

    let result = run_nested_command(&request)?;
    inspect_root(Path::new("/workspace"))?;
    let final_tree = workspace_quota::snapshot_tree(Path::new("/workspace"))?;
    workspace_quota::commit_tree(commit_root, Path::new("/workspace"), &baseline, &final_tree)?;
    Ok(result)
}

fn run_nested_command(request: &InnerRequest) -> Result<InnerResult, String> {
    let mut args: Vec<OsString> = vec![
        "--unshare-mnt".into(),
        "--unshare-pid".into(),
        "--unshare-net".into(),
        "--unshare-ipc".into(),
        "--unshare-uts".into(),
        "--new-session".into(),
        "--die-with-parent".into(),
        "--disable-userns".into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--ro-bind".into(),
        "/usr".into(),
        "/usr".into(),
    ];
    for (source, destination) in [
        ("usr/bin", "/bin"),
        ("usr/sbin", "/sbin"),
        ("usr/lib", "/lib"),
        ("usr/lib64", "/lib64"),
    ] {
        let source_path = Path::new("/usr").join(source.strip_prefix("usr/").unwrap_or(source));
        if source_path.exists() {
            args.extend(["--symlink".into(), source.into(), destination.into()]);
        }
    }
    args.extend([
        "--proc".into(),
        "/proc".into(),
        "--dev".into(),
        "/dev".into(),
        "--size".into(),
        MAX_FILE_BYTES.to_string().into(),
        "--perms".into(),
        "1777".into(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--dir".into(),
        "/workspace".into(),
        "--bind".into(),
        "/workspace".into(),
        "/workspace".into(),
        "--ro-bind".into(),
        "/bt-linux-isolation-helper".into(),
        "/bt-linux-isolation-helper".into(),
        "--chdir".into(),
        request.cwd.as_os_str().to_owned(),
        "--clearenv".into(),
        "--setenv".into(),
        "PATH".into(),
        "/usr/bin:/bin".into(),
        "--setenv".into(),
        "HOME".into(),
        "/workspace".into(),
        "--setenv".into(),
        "TMPDIR".into(),
        "/tmp".into(),
        "--setenv".into(),
        "LANG".into(),
        "C.UTF-8".into(),
        "--setenv".into(),
        "BT_MAX_OUTPUT_BYTES".into(),
        std::env::var("BT_MAX_OUTPUT_BYTES")
            .unwrap_or_else(|_| "64000".to_string())
            .into(),
        "--".into(),
        "/bt-linux-isolation-helper".into(),
        "--command-inner".into(),
        "--cwd".into(),
        request.cwd.as_os_str().to_owned(),
    ]);
    for (name, inode) in request.namespaces.iter() {
        args.push(format!("--expect-{name}={inode}").into());
    }
    args.push("--".into());
    args.push(request.command.clone());
    args.extend(request.args.iter().cloned());

    let mut child = Command::new("/usr/bin/bwrap")
        .args(args)
        .current_dir("/")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", "/workspace")
        .env("TMPDIR", "/tmp")
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "sandbox_command_start_failed".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sandbox_output_unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "sandbox_output_unavailable".to_string())?;
    let output = Arc::new(Mutex::new(CapturedOutput::default()));
    let stdout_thread = spawn_reader(stdout, Arc::clone(&output), true, MAX_RESPONSE_BYTES);
    let stderr_thread = spawn_reader(stderr, Arc::clone(&output), false, MAX_RESPONSE_BYTES);
    let status = child
        .wait()
        .map_err(|_| "sandbox_command_wait_failed".to_string())?;
    let (_, tree_clean) = kill_sandbox_descendants()?;
    if !tree_clean {
        return Err("sandbox_process_tree_shutdown_unconfirmed".to_string());
    }
    let stdout_thread = stdout_thread
        .join()
        .map_err(|_| "sandbox_output_capture_failed".to_string())?;
    let stderr_thread = stderr_thread
        .join()
        .map_err(|_| "sandbox_output_capture_failed".to_string())?;
    if stdout_thread.is_err() || stderr_thread.is_err() {
        return Err("sandbox_output_capture_failed".to_string());
    }
    let output = output
        .lock()
        .map_err(|_| "sandbox_output_capture_failed".to_string())?;
    if output.truncated {
        return Err("sandbox_result_exceeded_bound".to_string());
    }
    if !status.success() {
        let diagnostic = safe_diagnostic(&output.stderr);
        return Err(if diagnostic.is_empty() {
            "sandbox_start_or_shutdown_failed".to_string()
        } else {
            format!("sandbox_start_or_shutdown_failed:{diagnostic}")
        });
    }
    parse_inner_frame(&output.stdout)
}

fn run_command_inner(request: InnerRequest) -> Result<InnerResult, String> {
    verify_inner_isolation(&request.namespaces)?;
    set_dumpable(false)?;
    let mut command = Command::new(&request.command);
    command
        .args(&request.args)
        .current_dir(&request.cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", "/workspace")
        .env("TMPDIR", "/tmp")
        .env("LANG", "C.UTF-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            let file_size = libc::rlimit {
                rlim_cur: MAX_FILE_BYTES as libc::rlim_t,
                rlim_max: MAX_FILE_BYTES as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &file_size) != 0
                || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let command = command
        .spawn()
        .map_err(|_| "sandbox_command_start_failed".to_string())?;
    let mut command = command;
    let stdout = command
        .stdout
        .take()
        .ok_or_else(|| "sandbox_output_unavailable".to_string())?;
    let stderr = command
        .stderr
        .take()
        .ok_or_else(|| "sandbox_output_unavailable".to_string())?;
    let max_output_bytes = std::env::var("BT_MAX_OUTPUT_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(64_000)
        .clamp(1, MAX_OUTPUT_BYTES);
    let output = Arc::new(Mutex::new(CapturedOutput::default()));
    let stdout_thread = spawn_reader(stdout, Arc::clone(&output), true, max_output_bytes);
    let stderr_thread = spawn_reader(stderr, Arc::clone(&output), false, max_output_bytes);
    let status = command
        .wait()
        .map_err(|_| "sandbox_command_wait_failed".to_string())?;
    let (descendants_seen, tree_clean) = kill_sandbox_descendants()?;
    if !tree_clean {
        return Err("sandbox_process_tree_shutdown_unconfirmed".to_string());
    }
    let stdout_thread = stdout_thread
        .join()
        .map_err(|_| "sandbox_output_capture_failed".to_string())?;
    let stderr_thread = stderr_thread
        .join()
        .map_err(|_| "sandbox_output_capture_failed".to_string())?;
    if stdout_thread.is_err() || stderr_thread.is_err() {
        return Err("sandbox_output_capture_failed".to_string());
    }
    let output = output
        .lock()
        .map_err(|_| "sandbox_output_capture_failed".to_string())?;
    Ok(InnerResult {
        exit_code: exit_status_code(status),
        stdout: output.stdout.clone(),
        stderr: output.stderr.clone(),
        truncated: output.truncated,
        descendants_seen,
    })
}

fn verify_inner_isolation(expected: &BTreeMap<String, u64>) -> Result<(), String> {
    verify_namespace_isolation(expected)?;
    let status = fs::read_to_string("/proc/self/status")
        .map_err(|_| "sandbox_status_unavailable".to_string())?;
    let cap_eff = status
        .lines()
        .find_map(|line| line.strip_prefix("CapEff:").map(str::trim))
        .ok_or_else(|| "sandbox_capabilities_unverified".to_string())?;
    if cap_eff.bytes().any(|byte| byte != b'0')
        || status.lines().any(|line| {
            ["CapPrm:", "CapAmb:"].iter().any(|key| {
                line.strip_prefix(key)
                    .is_some_and(|value| value.trim().chars().any(|ch| ch != '0'))
            })
        })
    {
        return Err("sandbox_capabilities_unverified".to_string());
    }
    let current_dir =
        fs::canonicalize("/proc/self/cwd").map_err(|_| "sandbox_cwd_invalid".to_string())?;
    if !current_dir.starts_with("/workspace") {
        return Err("sandbox_cwd_invalid".to_string());
    }
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if !matches!(
            key.as_ref(),
            "PATH" | "HOME" | "TMPDIR" | "LANG" | "PWD" | "BT_MAX_OUTPUT_BYTES"
        ) {
            return Err("sandbox_environment_not_allowlisted".to_string());
        }
    }
    Ok(())
}

fn verify_outer_isolation(expected: &BTreeMap<String, u64>) -> Result<(), String> {
    verify_namespace_isolation(expected)?;
    let cwd = fs::canonicalize("/proc/self/cwd").map_err(|_| "sandbox_cwd_invalid".to_string())?;
    if cwd != Path::new("/") {
        return Err("sandbox_cwd_invalid".to_string());
    }
    let status = fs::read_to_string("/proc/self/status")
        .map_err(|_| "sandbox_status_unavailable".to_string())?;
    let capabilities = status
        .lines()
        .find_map(|line| line.strip_prefix("CapEff:").map(str::trim))
        .and_then(|value| u64::from_str_radix(value, 16).ok())
        .ok_or_else(|| "sandbox_capabilities_unverified".to_string())?;
    let permitted = status
        .lines()
        .find_map(|line| line.strip_prefix("CapPrm:").map(str::trim))
        .and_then(|value| u64::from_str_radix(value, 16).ok())
        .ok_or_else(|| "sandbox_capabilities_unverified".to_string())?;
    let ambient = status
        .lines()
        .find_map(|line| line.strip_prefix("CapAmb:").map(str::trim))
        .and_then(|value| u64::from_str_radix(value, 16).ok())
        .ok_or_else(|| "sandbox_capabilities_unverified".to_string())?;
    if capabilities != (1 << 21) || permitted != (1 << 21) || ambient != 0 {
        return Err("sandbox_mount_capability_unavailable".to_string());
    }
    verify_environment_allowlist()
}

fn verify_namespace_isolation(expected: &BTreeMap<String, u64>) -> Result<(), String> {
    for name in ["user", "mnt", "pid", "net", "ipc", "uts"] {
        let actual = namespace_inode(name)?;
        if expected.get(name).copied() == Some(actual) {
            return Err("sandbox_namespace_not_isolated".to_string());
        }
    }
    Ok(())
}

fn verify_environment_allowlist() -> Result<(), String> {
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if !matches!(
            key.as_ref(),
            "PATH" | "HOME" | "TMPDIR" | "LANG" | "PWD" | "BT_MAX_OUTPUT_BYTES"
        ) {
            return Err("sandbox_environment_not_allowlisted".to_string());
        }
    }
    Ok(())
}

fn set_dumpable(dumpable: bool) -> Result<(), String> {
    let result =
        unsafe { libc::prctl(libc::PR_SET_DUMPABLE, if dumpable { 1 } else { 0 }, 0, 0, 0) };
    if result != 0 {
        return Err("sandbox_process_protection_unavailable".to_string());
    }
    Ok(())
}

fn kill_sandbox_descendants() -> Result<(bool, bool), String> {
    let own_pid = std::process::id() as i32;
    let deadline = Instant::now() + TREE_SHUTDOWN_LIMIT;
    let mut descendants_seen = false;
    loop {
        let mut remaining = Vec::new();
        for entry in fs::read_dir("/proc").map_err(|_| "sandbox_proc_unavailable".to_string())? {
            let entry = entry.map_err(|_| "sandbox_proc_unavailable".to_string())?;
            let name = entry.file_name();
            let Some(pid) = name.to_str().and_then(|value| value.parse::<i32>().ok()) else {
                continue;
            };
            if pid != 1 && pid != own_pid {
                descendants_seen = true;
                remaining.push(pid);
            }
        }
        if remaining.is_empty() {
            return Ok((descendants_seen, true));
        }
        for pid in remaining {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        if Instant::now() >= deadline {
            return Ok((descendants_seen, false));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn write_inner_frame(result: &InnerResult) -> Result<(), String> {
    let stdout = &result.stdout;
    let stderr = &result.stderr;
    let mut out = io::stdout().lock();
    writeln!(
        out,
        "{}",
        String::from_utf8_lossy(&RESULT_MAGIC[..RESULT_MAGIC.len() - 1])
    )
    .map_err(|_| "sandbox_result_write_failed".to_string())?;
    writeln!(
        out,
        "{} {} {} {} {}",
        result.exit_code,
        u8::from(result.truncated),
        u8::from(result.descendants_seen),
        stdout.len(),
        stderr.len()
    )
    .map_err(|_| "sandbox_result_write_failed".to_string())?;
    out.write_all(b"\n")
        .map_err(|_| "sandbox_result_write_failed".to_string())?;
    out.write_all(stdout)
        .map_err(|_| "sandbox_result_write_failed".to_string())?;
    out.write_all(stderr)
        .map_err(|_| "sandbox_result_write_failed".to_string())?;
    out.flush()
        .map_err(|_| "sandbox_result_write_failed".to_string())
}

fn parse_inner_frame(input: &[u8]) -> Result<InnerResult, String> {
    if !input.starts_with(RESULT_MAGIC) {
        return Err("sandbox_result_handshake_missing".to_string());
    }
    let rest = &input[RESULT_MAGIC.len()..];
    let delimiter = rest
        .windows(2)
        .position(|window| window == b"\n\n")
        .ok_or_else(|| "sandbox_result_invalid".to_string())?;
    let header = std::str::from_utf8(&rest[..delimiter])
        .map_err(|_| "sandbox_result_invalid".to_string())?;
    let fields: Vec<&str> = header.split_whitespace().collect();
    if fields.len() != 5 {
        return Err("sandbox_result_invalid".to_string());
    }
    let exit_code = fields[0]
        .parse::<i32>()
        .map_err(|_| "sandbox_result_invalid".to_string())?;
    let truncated = parse_bool_bit(fields[1])?;
    let descendants_seen = parse_bool_bit(fields[2])?;
    let stdout_len = fields[3]
        .parse::<usize>()
        .map_err(|_| "sandbox_result_invalid".to_string())?;
    let stderr_len = fields[4]
        .parse::<usize>()
        .map_err(|_| "sandbox_result_invalid".to_string())?;
    let data = &rest[delimiter + 2..];
    if data.len() != stdout_len.saturating_add(stderr_len)
        || data.len() > MAX_OUTPUT_BYTES
        || input.len() > MAX_RESPONSE_BYTES
    {
        return Err("sandbox_result_invalid".to_string());
    }
    Ok(InnerResult {
        exit_code,
        stdout: data[..stdout_len].to_vec(),
        stderr: data[stdout_len..].to_vec(),
        truncated,
        descendants_seen,
    })
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    output: Arc<Mutex<CapturedOutput>>,
    is_stdout: bool,
    max_bytes: usize,
) -> thread::JoinHandle<Result<(), ()>> {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            let read = reader.read(&mut buffer).map_err(|_| ())?;
            if read == 0 {
                return Ok(());
            }
            let mut captured = output.lock().map_err(|_| ())?;
            let remaining = max_bytes.saturating_sub(captured.total_bytes);
            let kept = remaining.min(read);
            let destination = if is_stdout {
                &mut captured.stdout
            } else {
                &mut captured.stderr
            };
            destination.extend_from_slice(&buffer[..kept]);
            captured.total_bytes += kept;
            if kept < read {
                captured.truncated = true;
            }
        }
    })
}

fn verify_unit_tree_empty(unit: &UnitState, uid: u32) -> Result<bool, String> {
    if unit.active_state != "inactive" && unit.active_state != "failed" {
        return Ok(false);
    }
    if unit.control_group.is_empty() {
        return Ok(!unit.result.is_empty());
    }
    let expected_prefix = format!("/user.slice/user-{uid}.slice/user@{uid}.service/");
    if !unit.control_group.starts_with(&expected_prefix)
        || unit.control_group.contains("..")
        || unit.control_group.contains('\\')
    {
        return Err("linux_cgroup_path_unverified".to_string());
    }
    let cgroup = Path::new("/sys/fs/cgroup").join(unit.control_group.trim_start_matches('/'));
    if !cgroup.exists() {
        return Ok(true);
    }
    let processes = fs::read_to_string(cgroup.join("cgroup.procs"))
        .map_err(|_| "linux_cgroup_processes_unavailable".to_string())?;
    if !processes.trim().is_empty() {
        return Ok(false);
    }
    let events = fs::read_to_string(cgroup.join("cgroup.events"))
        .map_err(|_| "linux_cgroup_events_unavailable".to_string())?;
    Ok(events.lines().any(|line| line.trim() == "populated 0"))
}

fn query_unit(runtime_dir: &str, unit: &str) -> Result<UnitState, String> {
    let output = systemctl_user(
        runtime_dir,
        &[
            "show".into(),
            "--no-pager".into(),
            "--property=Result".into(),
            "--property=ExecMainCode".into(),
            "--property=ExecMainStatus".into(),
            "--property=ControlGroup".into(),
            "--property=ActiveState".into(),
            unit.into(),
        ],
    )?;
    if !output.status.success() {
        return Err("linux_unit_state_unavailable".to_string());
    }
    let values: BTreeMap<String, String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    Ok(UnitState {
        result: values.get("Result").cloned().unwrap_or_default(),
        exec_main_status: values.get("ExecMainStatus").cloned().unwrap_or_default(),
        control_group: values.get("ControlGroup").cloned().unwrap_or_default(),
        active_state: values.get("ActiveState").cloned().unwrap_or_default(),
    })
}

fn systemctl_user(runtime_dir: &str, args: &[String]) -> Result<std::process::Output, String> {
    Command::new("/usr/bin/systemctl")
        .arg("--user")
        .args(args)
        .current_dir("/")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("XDG_RUNTIME_DIR", runtime_dir)
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={runtime_dir}/bus"),
        )
        .env("LANG", "C.UTF-8")
        .output()
        .map_err(|_| "linux_systemctl_unavailable".to_string())
}

fn ensure_runtime_prerequisites() -> Result<(), String> {
    for path in [
        "/usr/bin/bwrap",
        "/usr/bin/systemd-run",
        "/usr/bin/systemctl",
    ] {
        let metadata =
            fs::metadata(path).map_err(|_| "linux_isolation_prerequisite_missing".to_string())?;
        if !metadata.is_file() {
            return Err("linux_isolation_prerequisite_missing".to_string());
        }
    }
    let uid = unsafe { libc::geteuid() };
    let runtime_dir = format!("/run/user/{uid}");
    let manager_socket = Path::new(&runtime_dir).join("systemd/private");
    if !manager_socket.exists() {
        return Err("linux_user_manager_unavailable".to_string());
    }
    let cgroup = fs::read_to_string("/sys/fs/cgroup/cgroup.controllers")
        .map_err(|_| "linux_cgroup_v2_unavailable".to_string())?;
    if !["cpu", "memory", "pids"]
        .iter()
        .all(|name| cgroup.split_whitespace().any(|item| item == *name))
    {
        return Err("linux_resource_controllers_unavailable".to_string());
    }
    Ok(())
}

fn namespace_ids() -> Result<BTreeMap<String, u64>, String> {
    let mut values = BTreeMap::new();
    for name in ["user", "mnt", "pid", "net", "ipc", "uts"] {
        values.insert(name.to_string(), namespace_inode(name)?);
    }
    Ok(values)
}

fn namespace_inode(name: &str) -> Result<u64, String> {
    let link = fs::read_link(format!("/proc/self/ns/{name}"))
        .map_err(|_| "linux_namespace_unavailable".to_string())?;
    let link = link.to_string_lossy();
    let value = link
        .split(['[', ']'])
        .nth(1)
        .ok_or_else(|| "linux_namespace_unavailable".to_string())?;
    value
        .parse::<u64>()
        .map_err(|_| "linux_namespace_unavailable".to_string())
}

fn inspect_root(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut count = 0usize;
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory).map_err(|_| "shell_root_unreadable".to_string())?;
        for entry in entries {
            count += 1;
            if count > MAX_ROOT_ENTRIES {
                return Err("shell_root_entry_limit_exceeded".to_string());
            }
            let entry = entry.map_err(|_| "shell_root_unreadable".to_string())?;
            let path = entry.path();
            if is_secret_path(&path) {
                return Err("shell_root_contains_secret_like_path".to_string());
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| "shell_root_changed_during_validation".to_string())?;
            let file_type = metadata.file_type();
            if file_type.is_symlink() || !(file_type.is_file() || file_type.is_dir()) {
                return Err("shell_root_contains_unsupported_entry".to_string());
            }
            if file_type.is_file() && metadata.nlink() != 1 {
                return Err("shell_root_contains_hard_link".to_string());
            }
            if file_type.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(())
}

fn is_secret_path(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(value) = component else {
            return false;
        };
        is_secret_component(value)
    })
}

fn has_secret_relative_component(root: &Path, child: &Path) -> bool {
    child.strip_prefix(root).map(is_secret_path).unwrap_or(true)
}

fn is_secret_component(value: &OsStr) -> bool {
    let lower = value.to_string_lossy().to_ascii_lowercase();
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

fn validate_command(command: &OsStr, args: &[OsString]) -> Result<(), String> {
    let command = command.to_string_lossy();
    if command.is_empty() || command.contains('/') || command.contains('\\') {
        return Err("invalid_command".to_string());
    }
    let denied = [
        "rm", "rmdir", "del", "erase", "shred", "dd", "mkfs", "format", "diskpart", "shutdown",
        "reboot", "halt", "poweroff", "sudo", "su",
    ];
    if denied
        .iter()
        .any(|value| command.eq_ignore_ascii_case(value))
    {
        return Err("command_denied".to_string());
    }
    for arg in args {
        let normalized = arg.to_string_lossy().trim().to_ascii_lowercase();
        if normalized == "/"
            || normalized == "\\"
            || normalized == "--no-preserve-root"
            || normalized == "-rf"
            || normalized == "-fr"
            || normalized.contains("..")
        {
            return Err("argument_denied".to_string());
        }
    }
    Ok(())
}

fn parse_bounded_u64(value: &OsStr, min: u64, max: u64) -> Result<u64, String> {
    let parsed = value
        .to_string_lossy()
        .parse::<u64>()
        .map_err(|_| "invalid_request".to_string())?;
    if parsed < min || parsed > max {
        return Err("invalid_request".to_string());
    }
    Ok(parsed)
}

fn parse_bounded_usize(value: &OsStr, min: usize, max: usize) -> Result<usize, String> {
    let parsed = value
        .to_string_lossy()
        .parse::<usize>()
        .map_err(|_| "invalid_request".to_string())?;
    if parsed < min || parsed > max {
        return Err("invalid_request".to_string());
    }
    Ok(parsed)
}

fn read_uuid() -> Result<String, String> {
    let value = fs::read_to_string("/proc/sys/kernel/random/uuid")
        .map_err(|_| "unit_identity_unavailable".to_string())?;
    let uuid = value.trim();
    if uuid.len() != 36
        || !uuid
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("unit_identity_unavailable".to_string());
    }
    Ok(uuid.replace('-', ""))
}

fn exit_status_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(128)
}

fn parse_bool_bit(value: &str) -> Result<bool, String> {
    match value {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err("sandbox_result_invalid".to_string()),
    }
}

fn result_json(
    exit_code: Option<i32>,
    signal: Option<&str>,
    timed_out: bool,
    stdout: &str,
    stderr: &str,
    truncated: bool,
    process_tree_empty: bool,
    descendants_terminated: bool,
) -> String {
    let exit_json = exit_code
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".to_string());
    let signal_json = signal
        .map(json_string)
        .unwrap_or_else(|| "null".to_string());
    format!(
        "{{\"exit_code\":{exit_json},\"signal\":{signal_json},\"timed_out\":{timed_out},\"stdout\":{},\"stderr\":{},\"truncated\":{truncated},\"process_tree_empty\":{process_tree_empty},\"descendants_terminated\":{descendants_terminated}}}",
        json_string(stdout),
        json_string(stderr)
    )
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn safe_diagnostic(bytes: &[u8]) -> String {
    let value = String::from_utf8_lossy(bytes).trim().to_string();
    if value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_:.-".contains(&byte))
    {
        value
    } else {
        let lower = value.to_ascii_lowercase();
        if lower.contains("operation not permitted") {
            "operation_not_permitted".to_string()
        } else if lower.contains("permission denied") {
            "permission_denied".to_string()
        } else if lower.contains("no space left on device") {
            "no_space_left".to_string()
        } else if lower.contains("invalid argument") {
            "invalid_argument".to_string()
        } else if lower.starts_with("bwrap:") {
            "bubblewrap_launch_failed".to_string()
        } else if lower.contains("systemd") {
            "systemd_launch_failed".to_string()
        } else {
            String::new()
        }
    }
}

fn stable_error(error: &str) -> String {
    let code = error.split(':').next().unwrap_or("provider_error");
    if code
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        let detail = error.rsplit(':').next().unwrap_or_default();
        const SAFE_DETAILS: &[&str] = &[
            "workspace_quota_unavailable",
            "workspace_commit_failed",
            "workspace_changed_during_execution",
            "workspace_write_limit_exceeded",
            "shell_root_size_limit_exceeded",
            "shell_root_entry_limit_exceeded",
            "shell_root_contains_hard_link",
            "shell_root_contains_unsupported_entry",
            "shell_root_unreadable",
            "shell_root_changed_during_validation",
            "sandbox_mount_capability_unavailable",
            "sandbox_namespace_not_isolated",
            "sandbox_start_or_shutdown_failed",
            "sandbox_command_start_failed",
            "sandbox_command_wait_failed",
            "sandbox_output_capture_failed",
            "sandbox_result_exceeded_bound",
            "operation_not_permitted",
            "permission_denied",
            "no_space_left",
            "invalid_argument",
            "bubblewrap_launch_failed",
            "systemd_launch_failed",
        ];
        if matches!(
            code,
            "linux_sandbox_start_or_shutdown_failed" | "sandbox_start_or_shutdown_failed"
        ) && SAFE_DETAILS.contains(&detail)
        {
            format!("{code}:{detail}")
        } else {
            code.to_string()
        }
    } else {
        "provider_error".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{safe_diagnostic, stable_error};

    #[test]
    fn diagnostics_keep_only_allowlisted_failure_codes() {
        assert_eq!(
            safe_diagnostic(b"bwrap: setting up uid map: Operation not permitted\n"),
            "operation_not_permitted"
        );
        assert_eq!(safe_diagnostic(b"/tmp/private path: rejected\n"), "");
        assert_eq!(
            stable_error(
                "linux_sandbox_start_or_shutdown_failed:linux_isolation_error:workspace_quota_unavailable"
            ),
            "linux_sandbox_start_or_shutdown_failed:workspace_quota_unavailable"
        );
        assert_eq!(
            stable_error("linux_sandbox_start_or_shutdown_failed:/tmp/private path"),
            "linux_sandbox_start_or_shutdown_failed"
        );
    }
}
