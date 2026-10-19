use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

pub const MAX_WORKSPACE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_WORKSPACE_WRITE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES: usize = 100_000;
const STORAGE_PATH: &str = "/workspace-storage";
const LOWER_PATH: &str = "/workspace-lower";
const WORKSPACE_PATH: &str = "/workspace";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntryKind {
    File,
    Directory,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryFingerprint {
    kind: EntryKind,
    mode: u32,
    len: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
    nlink: u64,
    blocks: u64,
}

pub type WorkspaceSnapshot = BTreeMap<PathBuf, EntryFingerprint>;

pub fn snapshot_tree(root: &Path) -> Result<WorkspaceSnapshot, String> {
    let mut snapshot = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    let mut entry_count = 0usize;
    let mut logical_bytes = 0u64;
    let mut allocated_bytes = 0u64;

    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory).map_err(|_| "shell_root_unreadable".to_string())?;
        for entry in entries {
            entry_count += 1;
            if entry_count > MAX_WORKSPACE_ENTRIES {
                return Err("shell_root_entry_limit_exceeded".to_string());
            }
            let entry = entry.map_err(|_| "shell_root_unreadable".to_string())?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "shell_root_unreadable".to_string())?
                .to_path_buf();
            validate_relative_path(&relative)?;
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| "shell_root_changed_during_validation".to_string())?;
            let file_type = metadata.file_type();
            let kind = if file_type.is_file() {
                if metadata.nlink() != 1 {
                    return Err("shell_root_contains_hard_link".to_string());
                }
                logical_bytes = logical_bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| "shell_root_size_limit_exceeded".to_string())?;
                EntryKind::File
            } else if file_type.is_dir() {
                pending.push(path.clone());
                EntryKind::Directory
            } else {
                return Err("shell_root_contains_unsupported_entry".to_string());
            };
            allocated_bytes = allocated_bytes
                .checked_add(metadata.blocks().saturating_mul(512))
                .ok_or_else(|| "shell_root_size_limit_exceeded".to_string())?;
            if logical_bytes > MAX_WORKSPACE_BYTES || allocated_bytes > MAX_WORKSPACE_BYTES {
                return Err("shell_root_size_limit_exceeded".to_string());
            }
            snapshot.insert(relative, fingerprint(&metadata, kind));
        }
    }
    Ok(snapshot)
}

pub fn mount_bounded_overlay() -> Result<(), String> {
    let storage =
        CString::new(STORAGE_PATH).map_err(|_| "workspace_quota_unavailable".to_string())?;
    let tmpfs = CString::new("tmpfs").map_err(|_| "workspace_quota_unavailable".to_string())?;
    let tmpfs_options = CString::new(format!(
        "size={MAX_WORKSPACE_WRITE_BYTES},nr_inodes={MAX_WORKSPACE_ENTRIES},mode=0700"
    ))
    .map_err(|_| "workspace_quota_unavailable".to_string())?;
    let mounted = unsafe {
        libc::mount(
            tmpfs.as_ptr(),
            storage.as_ptr(),
            tmpfs.as_ptr(),
            (libc::MS_NODEV | libc::MS_NOSUID) as libc::c_ulong,
            tmpfs_options.as_ptr().cast(),
        )
    };
    if mounted != 0 {
        return Err(
            storage_mount_error_code(io::Error::last_os_error().raw_os_error()).to_string(),
        );
    }

    let upper = Path::new(STORAGE_PATH).join("upper");
    let work = Path::new(STORAGE_PATH).join("work");
    fs::create_dir(&upper).map_err(|_| "workspace_storage_layout_failed".to_string())?;
    fs::create_dir(&work).map_err(|_| "workspace_storage_layout_failed".to_string())?;

    let overlay = CString::new("overlay").map_err(|_| "workspace_quota_unavailable".to_string())?;
    let destination =
        CString::new(WORKSPACE_PATH).map_err(|_| "workspace_quota_unavailable".to_string())?;
    let options = CString::new(format!(
        "lowerdir={LOWER_PATH},upperdir={},workdir={},userxattr,redirect_dir=nofollow,metacopy=off,index=off",
        upper.display(),
        work.display()
    ))
    .map_err(|_| "workspace_quota_unavailable".to_string())?;
    let mounted = unsafe {
        libc::mount(
            overlay.as_ptr(),
            destination.as_ptr(),
            overlay.as_ptr(),
            (libc::MS_NODEV | libc::MS_NOSUID) as libc::c_ulong,
            options.as_ptr().cast(),
        )
    };
    if mounted != 0 {
        return Err(
            overlay_mount_error_code(io::Error::last_os_error().raw_os_error()).to_string(),
        );
    }
    Ok(())
}

fn storage_mount_error_code(errno: Option<i32>) -> &'static str {
    match errno {
        Some(libc::EPERM) => "workspace_storage_mount_operation_denied",
        Some(libc::EACCES) => "workspace_storage_mount_access_denied",
        Some(libc::EINVAL) => "workspace_storage_mount_invalid_options",
        Some(libc::ENODEV) => "workspace_storage_mount_unsupported",
        _ => "workspace_storage_mount_failed",
    }
}

fn overlay_mount_error_code(errno: Option<i32>) -> &'static str {
    match errno {
        Some(libc::EPERM) => "workspace_overlay_mount_operation_denied",
        Some(libc::EACCES) => "workspace_overlay_mount_access_denied",
        Some(libc::EINVAL) => "workspace_overlay_mount_invalid_options",
        Some(libc::ENODEV) | Some(libc::EOPNOTSUPP) | Some(libc::ENOSYS) => {
            "workspace_overlay_mount_unsupported"
        }
        _ => "workspace_overlay_mount_failed",
    }
}

pub fn commit_tree(
    target_root: &Path,
    workspace_root: &Path,
    baseline: &WorkspaceSnapshot,
    final_tree: &WorkspaceSnapshot,
) -> Result<(), String> {
    let current_target = snapshot_tree(target_root)?;
    if !snapshots_equal(baseline, &current_target) {
        return Err("workspace_changed_during_execution".to_string());
    }
    enforce_workspace_limit(final_tree)?;

    let mut changed_bytes = 0u64;
    let mut remove = Vec::new();
    let mut create_directories = Vec::new();
    let mut copy_files = Vec::new();
    let mut update_directories = Vec::new();

    for (path, before) in baseline {
        match final_tree.get(path) {
            None => remove.push((path.clone(), before.kind)),
            Some(after) if before.kind != after.kind => {
                remove.push((path.clone(), before.kind));
            }
            _ => {}
        }
    }
    remove.sort_by_key(|(path, _)| std::cmp::Reverse(path_depth(path)));

    for (path, after) in final_tree {
        match after.kind {
            EntryKind::Directory => {
                let before = baseline.get(path);
                if before.is_none_or(|value| value.kind != EntryKind::Directory) {
                    create_directories.push(path.clone());
                }
                if before.is_none_or(|value| !same_state(value, after)) {
                    update_directories.push(path.clone());
                }
            }
            EntryKind::File => {
                let before = baseline.get(path);
                if before
                    .is_none_or(|value| value.kind != EntryKind::File || !same_state(value, after))
                {
                    changed_bytes = changed_bytes
                        .checked_add(after.len)
                        .ok_or_else(|| "workspace_write_limit_exceeded".to_string())?;
                    copy_files.push(path.clone());
                }
            }
        }
    }
    if changed_bytes > MAX_WORKSPACE_WRITE_BYTES {
        return Err("workspace_write_limit_exceeded".to_string());
    }

    let target = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(target_root)
        .map_err(|_| "workspace_commit_failed".to_string())?;
    for (path, kind) in &remove {
        remove_entry_at(&target, path, *kind)?;
    }

    create_directories.sort_by_key(|path| path_depth(path));
    for path in &create_directories {
        create_directory_at(&target, path)?;
    }

    copy_files.sort();
    for path in &copy_files {
        let metadata = fs::symlink_metadata(workspace_root.join(path))
            .map_err(|_| "workspace_commit_failed".to_string())?;
        copy_file_at(&target, workspace_root, path, &metadata)?;
    }

    update_directories.sort_by_key(|path| std::cmp::Reverse(path_depth(path)));
    for path in &update_directories {
        let metadata = fs::symlink_metadata(workspace_root.join(path))
            .map_err(|_| "workspace_commit_failed".to_string())?;
        update_directory_at(&target, path, &metadata)?;
    }
    Ok(())
}

fn enforce_workspace_limit(snapshot: &WorkspaceSnapshot) -> Result<(), String> {
    let mut logical_bytes = 0u64;
    let mut allocated_bytes = 0u64;
    for entry in snapshot.values() {
        allocated_bytes = allocated_bytes
            .checked_add(entry.blocks.saturating_mul(512))
            .ok_or_else(|| "shell_root_size_limit_exceeded".to_string())?;
        if entry.kind == EntryKind::File {
            logical_bytes = logical_bytes
                .checked_add(entry.len)
                .ok_or_else(|| "shell_root_size_limit_exceeded".to_string())?;
        }
    }
    if logical_bytes > MAX_WORKSPACE_BYTES || allocated_bytes > MAX_WORKSPACE_BYTES {
        return Err("shell_root_size_limit_exceeded".to_string());
    }
    Ok(())
}

fn snapshots_equal(left: &WorkspaceSnapshot, right: &WorkspaceSnapshot) -> bool {
    left.len() == right.len()
        && left.iter().all(|(path, before)| {
            right
                .get(path)
                .is_some_and(|after| same_state(before, after))
        })
}

fn same_state(left: &EntryFingerprint, right: &EntryFingerprint) -> bool {
    if left.kind != right.kind
        || left.mode != right.mode
        || left.mtime != right.mtime
        || left.mtime_nsec != right.mtime_nsec
        || left.ctime != right.ctime
        || left.ctime_nsec != right.ctime_nsec
    {
        return false;
    }
    left.kind == EntryKind::Directory || (left.len == right.len && left.nlink == right.nlink)
}

fn fingerprint(metadata: &Metadata, kind: EntryKind) -> EntryFingerprint {
    EntryFingerprint {
        kind,
        mode: metadata.mode() & 0o777,
        len: metadata.len(),
        mtime: metadata.mtime(),
        mtime_nsec: metadata.mtime_nsec(),
        ctime: metadata.ctime(),
        ctime_nsec: metadata.ctime_nsec(),
        nlink: metadata.nlink(),
        blocks: metadata.blocks(),
    }
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("workspace_commit_failed".to_string());
    }
    Ok(())
}

fn path_depth(path: &Path) -> usize {
    path.components().count()
}

fn duplicate_directory(directory: &File) -> Result<File, String> {
    let fd = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if fd < 0 {
        return Err("workspace_commit_failed".to_string());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn parent_directory_at(
    root: &File,
    relative: &Path,
    create: bool,
) -> Result<(File, CString), String> {
    validate_relative_path(relative)?;
    let components: Vec<_> = relative.components().collect();
    let (last, parents) = components
        .split_last()
        .ok_or_else(|| "workspace_commit_failed".to_string())?;
    let Component::Normal(last) = last else {
        return Err("workspace_commit_failed".to_string());
    };
    let name = CString::new(last.as_bytes()).map_err(|_| "workspace_commit_failed".to_string())?;
    let mut directory = duplicate_directory(root)?;
    for component in parents {
        let Component::Normal(value) = component else {
            return Err("workspace_commit_failed".to_string());
        };
        let child =
            CString::new(value.as_bytes()).map_err(|_| "workspace_commit_failed".to_string())?;
        let mut fd = open_directory_at(directory.as_raw_fd(), &child);
        if fd.is_err() && create {
            let made = unsafe { libc::mkdirat(directory.as_raw_fd(), child.as_ptr(), 0o700) };
            if made != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err("workspace_commit_failed".to_string());
            }
            fd = open_directory_at(directory.as_raw_fd(), &child);
        }
        directory = fd?;
    }
    Ok((directory, name))
}

fn open_directory_at(parent: i32, name: &CString) -> Result<File, String> {
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("workspace_commit_failed".to_string());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn create_directory_at(root: &File, relative: &Path) -> Result<(), String> {
    let (parent, name) = parent_directory_at(root, relative, true)?;
    let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
    if result != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
        return Err("workspace_commit_failed".to_string());
    }
    open_directory_at(parent.as_raw_fd(), &name)?;
    Ok(())
}

fn remove_entry_at(root: &File, relative: &Path, kind: EntryKind) -> Result<(), String> {
    let (parent, name) = parent_directory_at(root, relative, false)?;
    let flags = if kind == EntryKind::Directory {
        libc::AT_REMOVEDIR
    } else {
        0
    };
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if result != 0 {
        return Err("workspace_commit_failed".to_string());
    }
    Ok(())
}

fn copy_file_at(
    root: &File,
    workspace_root: &Path,
    relative: &Path,
    metadata: &Metadata,
) -> Result<(), String> {
    let mut source = File::open(workspace_root.join(relative))
        .map_err(|_| "workspace_commit_failed".to_string())?;
    let (parent, name) = parent_directory_at(root, relative, true)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("workspace_commit_failed".to_string());
    }
    let mut destination = unsafe { File::from_raw_fd(fd) };
    let copied = io::copy(&mut source, &mut destination)
        .map_err(|_| "workspace_commit_failed".to_string())?;
    if copied != metadata.len()
        || unsafe { libc::fchmod(destination.as_raw_fd(), metadata.mode() & 0o777) } != 0
    {
        return Err("workspace_commit_failed".to_string());
    }
    set_file_times(destination.as_raw_fd(), metadata)?;
    destination
        .flush()
        .map_err(|_| "workspace_commit_failed".to_string())?;
    Ok(())
}

fn update_directory_at(root: &File, relative: &Path, metadata: &Metadata) -> Result<(), String> {
    let (parent, name) = parent_directory_at(root, relative, false)?;
    let directory = open_directory_at(parent.as_raw_fd(), &name)?;
    if unsafe { libc::fchmod(directory.as_raw_fd(), metadata.mode() & 0o777) } != 0 {
        return Err("workspace_commit_failed".to_string());
    }
    set_file_times(directory.as_raw_fd(), metadata)
}

fn set_file_times(fd: i32, metadata: &Metadata) -> Result<(), String> {
    let times = [
        libc::timespec {
            tv_sec: metadata.atime() as libc::time_t,
            tv_nsec: metadata.atime_nsec() as libc::c_long,
        },
        libc::timespec {
            tv_sec: metadata.mtime() as libc::time_t,
            tv_nsec: metadata.mtime_nsec() as libc::c_long,
        },
    ];
    if unsafe { libc::futimens(fd, times.as_ptr()) } != 0 {
        return Err("workspace_commit_failed".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{overlay_mount_error_code, storage_mount_error_code};

    #[test]
    fn storage_mount_errno_maps_to_fixed_codes() {
        assert_eq!(
            storage_mount_error_code(Some(libc::EPERM)),
            "workspace_storage_mount_operation_denied"
        );
        assert_eq!(
            storage_mount_error_code(Some(libc::EACCES)),
            "workspace_storage_mount_access_denied"
        );
        assert_eq!(
            storage_mount_error_code(Some(libc::EINVAL)),
            "workspace_storage_mount_invalid_options"
        );
        assert_eq!(
            storage_mount_error_code(Some(libc::ENODEV)),
            "workspace_storage_mount_unsupported"
        );
        assert_eq!(
            storage_mount_error_code(Some(libc::EIO)),
            "workspace_storage_mount_failed"
        );
    }

    #[test]
    fn overlay_mount_errno_maps_to_fixed_codes() {
        assert_eq!(
            overlay_mount_error_code(Some(libc::EPERM)),
            "workspace_overlay_mount_operation_denied"
        );
        assert_eq!(
            overlay_mount_error_code(Some(libc::EACCES)),
            "workspace_overlay_mount_access_denied"
        );
        assert_eq!(
            overlay_mount_error_code(Some(libc::EINVAL)),
            "workspace_overlay_mount_invalid_options"
        );
        assert_eq!(
            overlay_mount_error_code(Some(libc::EOPNOTSUPP)),
            "workspace_overlay_mount_unsupported"
        );
        assert_eq!(
            overlay_mount_error_code(Some(libc::EIO)),
            "workspace_overlay_mount_failed"
        );
        assert_eq!(
            overlay_mount_error_code(None),
            "workspace_overlay_mount_failed"
        );
    }
}
