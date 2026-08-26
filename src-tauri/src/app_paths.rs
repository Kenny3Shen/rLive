use std::fs;
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::ffi::OsString;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::fs::OpenOptions;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::io::{self, ErrorKind, Write};
#[cfg(windows)]
use std::sync::LazyLock;

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct AppDirectories {
    pub root: PathBuf,
    pub logs: PathBuf,
    pub cache: PathBuf,
}

impl AppDirectories {
    pub fn resolve(_mobile_data_dir: Option<&Path>) -> AppResult<Self> {
        #[cfg(target_os = "android")]
        let root = application_root(_mobile_data_dir)?;

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
        let root = default_data_root(&system_data_root()?)?;

        fs::create_dir_all(&root).map_err(|error| {
            AppError::new(
                "app_data_dir_error",
                format!("create application directory {}: {error}", root.display()),
            )
        })?;
        Ok(Self {
            logs: root.join("logs"),
            cache: root.join("cache"),
            root,
        })
    }
}

/// `dirs` 刻意不暴露 Android 的应用沙箱目录。在那里回退到相对路径会让启动
/// 依赖进程工作目录（通常是 `/`），而应用无权写入该目录，
/// 因此移动端宿主必须提供私有数据目录。
#[cfg(target_os = "android")]
fn application_root(mobile_data_dir: Option<&Path>) -> AppResult<PathBuf> {
    mobile_data_dir
        .map(|directory| directory.join("rlive"))
        .ok_or_else(|| {
            AppError::new(
                "app_data_dir_error",
                "Android app data directory is unavailable during startup",
            )
        })
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn system_data_root() -> AppResult<PathBuf> {
    dirs::data_dir()
        .map(|directory| directory.join("rlive"))
        .ok_or_else(|| AppError::new("app_data_dir_error", "系统应用数据目录不可用"))
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn default_data_root(system_root: &Path) -> AppResult<PathBuf> {
    let install_root = std::env::current_exe().ok().and_then(|executable| {
        install_root_from_executable(&executable, cfg!(target_os = "macos"))
    });
    if let Some(install_root) = install_root {
        match prepare_data_root(&install_root) {
            Ok(root) => return Ok(root),
            Err(error) => eprintln!(
                "rLive installation directory is not writable ({}), using system app data: {error}",
                install_root.display()
            ),
        }
    }
    prepare_data_root(system_root)
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn install_root_from_executable(executable: &Path, macos_bundle: bool) -> Option<PathBuf> {
    if macos_bundle
        && let Some(bundle) = executable.ancestors().find(|ancestor| {
            ancestor
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
    {
        return bundle.parent().map(Path::to_path_buf);
    }
    executable.parent().map(Path::to_path_buf)
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn prepare_data_root(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(AppError::new(
            "app_data_path_invalid",
            "应用数据保存位置必须是绝对目录",
        ));
    }
    if path.parent().is_none() {
        return Err(AppError::new(
            "app_data_path_invalid",
            "不能将文件系统根目录作为应用数据保存位置",
        ));
    }
    fs::create_dir_all(path).map_err(|error| {
        AppError::new(
            "app_data_dir_error",
            format!("创建应用数据目录失败: {error}"),
        )
    })?;
    let root = fs::canonicalize(path).map_err(|error| {
        AppError::new(
            "app_data_dir_error",
            format!("解析应用数据目录失败: {error}"),
        )
    })?;
    if root.parent().is_none() {
        return Err(AppError::new(
            "app_data_path_invalid",
            "不能将文件系统根目录作为应用数据保存位置",
        ));
    }
    if !root.is_dir() {
        return Err(AppError::new(
            "app_data_path_invalid",
            "应用数据保存位置不是目录",
        ));
    }
    let probe = root.join(format!(".rlive-write-test-{}", Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .map_err(|error| {
            AppError::new("app_data_dir_error", format!("应用数据目录不可写: {error}"))
        })?;
    let result = file.write_all(b"ok").and_then(|_| file.flush());
    drop(file);
    let _ = fs::remove_file(&probe);
    result.map_err(|error| {
        AppError::new("app_data_dir_error", format!("应用数据目录不可写: {error}"))
    })?;
    Ok(root)
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn recoverable_sidecars(path: &Path) -> io::Result<(PathBuf, PathBuf)> {
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "配置文件名无效"))?;
    let mut temporary_name = OsString::from(file_name);
    temporary_name.push(".tmp");
    let mut backup_name = OsString::from(file_name);
    backup_name.push(".bak");
    Ok((
        path.with_file_name(temporary_name),
        path.with_file_name(backup_name),
    ))
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn read_optional_file(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn remove_file_if_present(path: &Path) -> io::Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(all(
    unix,
    any(target_os = "windows", target_os = "linux", target_os = "macos")
))]
fn sync_parent_directory(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "配置目录无效"))?;
    fs::File::open(parent)?.sync_all()
}

#[cfg(all(
    not(unix),
    any(target_os = "windows", target_os = "linux", target_os = "macos")
))]
fn sync_parent_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// 完成或回滚被中断的同目录替换。有效的目标文件表示替换已提交；
/// 否则有效的备份文件优先于未提交的临时文件。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub(crate) fn recover_recoverable_file(
    path: &Path,
    validate: impl Fn(&[u8]) -> bool,
) -> io::Result<()> {
    let (temporary, backup) = recoverable_sidecars(path)?;
    let target_bytes = read_optional_file(path)?;
    if target_bytes.as_deref().is_some_and(&validate) {
        let changed = remove_file_if_present(&temporary).unwrap_or(false)
            | remove_file_if_present(&backup).unwrap_or(false);
        if changed {
            let _ = sync_parent_directory(path);
        }
        return Ok(());
    }

    let backup_bytes = read_optional_file(&backup)?;
    if backup_bytes.as_deref().is_some_and(&validate) {
        remove_file_if_present(path)?;
        fs::rename(&backup, path)?;
        remove_file_if_present(&temporary)?;
        sync_parent_directory(path)?;
        return Ok(());
    }

    let temporary_bytes = read_optional_file(&temporary)?;
    if temporary_bytes.as_deref().is_some_and(&validate) {
        remove_file_if_present(path)?;
        remove_file_if_present(&backup)?;
        fs::rename(&temporary, path)?;
        sync_parent_directory(path)?;
        return Ok(());
    }

    if target_bytes.is_some() || temporary_bytes.is_some() || backup_bytes.is_some() {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("配置文件及其事务侧文件均无有效内容: {}", path.display()),
        ));
    }
    Ok(())
}

/// 以原子替换的方式发布已落盘的临时文件（Unix），
/// 在 Windows 无法直接改名覆盖目标时使用可恢复的备份事务。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub(crate) fn write_recoverable_file(
    path: &Path,
    bytes: &[u8],
    validate: impl Fn(&[u8]) -> bool,
) -> io::Result<()> {
    recover_recoverable_file(path, &validate)?;
    let (temporary, backup) = recoverable_sidecars(path)?;
    remove_file_if_present(&temporary)?;

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = remove_file_if_present(&temporary);
        return Err(error);
    }
    drop(file);

    publish_temporary_file(path, &temporary, &backup)
}

#[cfg(all(
    unix,
    any(target_os = "windows", target_os = "linux", target_os = "macos")
))]
fn publish_temporary_file(path: &Path, temporary: &Path, _backup: &Path) -> io::Result<()> {
    if let Err(error) = fs::rename(temporary, path) {
        let _ = remove_file_if_present(temporary);
        return Err(error);
    }
    sync_parent_directory(path)
}

#[cfg(all(
    not(unix),
    any(target_os = "windows", target_os = "linux", target_os = "macos")
))]
fn publish_temporary_file(path: &Path, temporary: &Path, backup: &Path) -> io::Result<()> {
    let had_target = path.exists();
    if had_target && let Err(error) = fs::rename(path, &backup) {
        let _ = remove_file_if_present(temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(temporary, path) {
        if had_target && let Err(rollback_error) = fs::rename(backup, path) {
            return Err(io::Error::new(
                error.kind(),
                format!("发布配置失败: {error}; 恢复原配置失败: {rollback_error}"),
            ));
        }
        let _ = remove_file_if_present(temporary);
        return Err(error);
    }
    sync_parent_directory(path)?;
    let _ = remove_file_if_present(backup);
    let _ = sync_parent_directory(path);
    Ok(())
}

/// 把原生文件系统路径转换为 IPC 与 JSON 使用的稳定形式。
/// `canonicalize` 在 Windows 上返回 verbatim 路径（`\\?\C:\...` 或
/// `\\?\UNC\server\share`），原生对话框和 Web UI 都不应暴露这种形式。
/// 进程内部的调用方仍可保留规范化后的 `PathBuf`。
pub(crate) fn path_to_string(path: &Path) -> String {
    strip_windows_verbatim_prefix(&path.to_string_lossy())
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
}

/// Windows 上的 CUDA 探测运行在 `AsrManager` 之外，
/// 需要与按需 ASR 运行时暂存位置相同的根目录。
#[cfg(windows)]
static PROCESS_APP_DATA_ROOT: LazyLock<Option<PathBuf>> = LazyLock::new(|| {
    system_data_root()
        .and_then(|system_root| default_data_root(&system_root))
        .ok()
});

#[cfg(windows)]
pub fn application_data_root() -> Option<PathBuf> {
    PROCESS_APP_DATA_ROOT.clone()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use uuid::Uuid;

    use super::{install_root_from_executable, prepare_data_root, strip_windows_verbatim_prefix};

    #[test]
    fn strips_windows_drive_verbatim_prefix() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\F:\rlive-replay"),
            r"F:\rlive-replay"
        );
    }

    #[test]
    fn converts_windows_verbatim_unc_to_regular_unc() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\rLive"),
            r"\\server\share\rLive"
        );
    }

    #[test]
    fn preserves_regular_paths() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"C:\Users\tester\rLive"),
            r"C:\Users\tester\rLive"
        );
        assert_eq!(strip_windows_verbatim_prefix("/tmp/rlive"), "/tmp/rlive");
    }

    #[test]
    fn macos_bundle_uses_the_directory_containing_the_app() {
        let executable = PathBuf::from("/Applications/rLive.app/Contents/MacOS/rlive");
        assert_eq!(
            install_root_from_executable(&executable, true),
            Some(PathBuf::from("/Applications"))
        );
        assert_eq!(
            install_root_from_executable(&executable, false),
            Some(PathBuf::from("/Applications/rLive.app/Contents/MacOS"))
        );
    }

    #[test]
    fn writable_directory_is_accepted_as_a_data_root() {
        let base = temp_directory("writable");
        std::fs::create_dir_all(&base).unwrap();

        let root = prepare_data_root(&base).unwrap();
        assert_eq!(root, std::fs::canonicalize(&base).unwrap());

        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn data_root_rejects_a_symlink_to_the_filesystem_root() {
        use std::os::unix::fs::symlink;

        let base = temp_directory("root-symlink");
        let selected = base.join("selected");
        std::fs::create_dir_all(&base).unwrap();
        symlink("/", &selected).unwrap();

        let error = prepare_data_root(&selected).unwrap_err();
        assert_eq!(error.code, "app_data_path_invalid");

        std::fs::remove_file(selected).unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }

    fn temp_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "rlive-app-paths-{label}-{}",
            Uuid::new_v4().simple()
        ))
    }
}
