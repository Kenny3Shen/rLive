#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::ffi::OsString;
use std::fs;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::fs::OpenOptions;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::OnceLock;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::sync::{Arc, Mutex};

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
const APP_DATA_BOOTSTRAP_FILE: &str = "app-data-bootstrap.json";
#[cfg(windows)]
static PROCESS_APP_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct AppDirectories {
    pub root: PathBuf,
    pub logs: PathBuf,
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub storage: AppDataStorage,
}

impl AppDirectories {
    pub fn resolve(_mobile_data_dir: Option<&Path>) -> AppResult<Self> {
        #[cfg(target_os = "android")]
        let root = application_root(_mobile_data_dir)?;

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
        let (root, storage) = AppDataStorage::resolve()?;

        fs::create_dir_all(&root).map_err(|error| {
            AppError::new(
                "app_data_dir_error",
                format!("create application directory {}: {error}", root.display()),
            )
        })?;
        Ok(Self {
            logs: root.join("logs"),
            root,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            storage,
        })
    }
}

/// The app data root is selected before SQLite, logging, ASR and recording are
/// initialized. Changing it while the process is running would leave those
/// resources split across directories, so settings only update the bootstrap
/// selection used by the next process.
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
#[derive(Debug, Clone)]
pub struct AppDataStorage {
    state: Arc<Mutex<AppDataStorageState>>,
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
#[derive(Debug)]
struct AppDataStorageState {
    current_root: PathBuf,
    default_root: PathBuf,
    selected_root: PathBuf,
    bootstrap_path: PathBuf,
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDataStorageInfo {
    /// Directory selected for the next launch.
    pub path: String,
    /// Directory used by the current process and its open resources.
    pub current_path: String,
    pub default_path: String,
    pub is_default: bool,
    pub restart_required: bool,
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppDataBootstrap {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    custom_path: Option<String>,
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl AppDataStorage {
    fn resolve() -> AppResult<(PathBuf, Self)> {
        let system_root = system_data_root()?;
        let bootstrap_path = bootstrap_path(&system_root);
        let default_root = default_data_root(&system_root)?;
        let selected_root = select_initial_root(&default_root, &bootstrap_path)?;
        #[cfg(windows)]
        let _ = PROCESS_APP_DATA_ROOT.set(selected_root.clone());
        let state = AppDataStorageState {
            current_root: selected_root.clone(),
            default_root,
            selected_root: selected_root.clone(),
            bootstrap_path,
        };
        Ok((
            selected_root,
            Self {
                state: Arc::new(Mutex::new(state)),
            },
        ))
    }

    pub fn info(&self) -> AppDataStorageInfo {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .info()
    }

    pub fn set_path(&self, requested: Option<String>) -> AppResult<AppDataStorageInfo> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AppError::new("app_data_dir_lock_error", "应用数据目录状态暂不可用"))?;
        let selected_root = match requested {
            Some(path) => {
                if path.trim().is_empty() {
                    return Err(AppError::new(
                        "app_data_path_invalid",
                        "应用数据保存位置不能为空",
                    ));
                }
                prepare_data_root(Path::new(&path))?
            }
            None => state.default_root.clone(),
        };
        write_bootstrap(
            &state.bootstrap_path,
            (selected_root != state.default_root).then_some(selected_root.as_path()),
        )?;
        state.selected_root = selected_root;
        Ok(state.info())
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl AppDataStorageState {
    fn info(&self) -> AppDataStorageInfo {
        AppDataStorageInfo {
            path: path_to_string(&self.selected_root),
            current_path: path_to_string(&self.current_root),
            default_path: path_to_string(&self.default_root),
            is_default: self.selected_root == self.default_root,
            restart_required: self.selected_root != self.current_root,
        }
    }
}

/// `dirs` deliberately does not expose Android's app sandbox. Falling back to a
/// relative path there makes startup depend on the process working directory
/// (normally `/`), which an app cannot write to, so the mobile host must supply
/// the private data directory.
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
fn bootstrap_path(system_root: &Path) -> PathBuf {
    dirs::config_dir()
        .map(|directory| directory.join("rlive"))
        .unwrap_or_else(|| system_root.to_path_buf())
        .join(APP_DATA_BOOTSTRAP_FILE)
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
fn read_bootstrap(path: &Path) -> AppResult<Option<AppDataBootstrap>> {
    recover_recoverable_file(path, valid_app_data_bootstrap).map_err(|error| {
        AppError::new(
            "app_data_config_error",
            format!("恢复应用数据目录引导配置失败 {}: {error}", path.display()),
        )
    })?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AppError::new(
                "app_data_config_error",
                format!("读取应用数据目录引导配置失败 {}: {error}", path.display()),
            ));
        }
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        AppError::new(
            "app_data_config_error",
            format!("应用数据目录引导配置已损坏 {}: {error}", path.display()),
        )
    })
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn valid_app_data_bootstrap(bytes: &[u8]) -> bool {
    serde_json::from_slice::<AppDataBootstrap>(bytes).is_ok()
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn select_initial_root(default_root: &Path, bootstrap_path: &Path) -> AppResult<PathBuf> {
    match read_bootstrap(bootstrap_path)? {
        Some(AppDataBootstrap {
            custom_path: Some(path),
        }) => {
            let configured = PathBuf::from(path);
            if !configured.is_absolute() {
                return Err(AppError::new(
                    "app_data_path_invalid",
                    format!(
                        "配置的应用数据保存位置不是绝对目录: {}。请修复或删除 {} 后重试",
                        configured.display(),
                        bootstrap_path.display()
                    ),
                ));
            }
            prepare_data_root(&configured).map_err(|error| {
                AppError::new(
                    "app_data_path_unavailable",
                    format!(
                        "配置的应用数据保存位置当前不可用 {}: {error}。为避免创建分叉数据，rLive 已停止启动；请恢复该目录或修复 {}",
                        configured.display(),
                        bootstrap_path.display()
                    ),
                )
            })
        }
        Some(AppDataBootstrap { custom_path: None }) => Ok(default_root.to_path_buf()),
        None => Ok(default_root.to_path_buf()),
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn write_bootstrap(path: &Path, custom_path: Option<&Path>) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("app_data_config_error", "应用数据目录引导配置路径无效"))?;
    fs::create_dir_all(parent).map_err(|error| {
        AppError::new(
            "app_data_config_error",
            format!("创建应用数据目录配置位置失败: {error}"),
        )
    })?;
    let config = AppDataBootstrap {
        custom_path: custom_path.map(path_to_string),
    };
    let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|error| AppError::new("app_data_config_error", error.to_string()))?;
    write_recoverable_file(path, &bytes, valid_app_data_bootstrap).map_err(|error| {
        AppError::new(
            "app_data_config_error",
            format!("保存应用数据目录设置失败: {error}"),
        )
    })
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

/// Completes or rolls back an interrupted same-directory replacement. A valid
/// target is already committed; otherwise a valid backup wins over an
/// uncommitted temporary file.
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

/// Publishes a synced temporary file with atomic replacement on Unix and a
/// recoverable backup transaction where Windows cannot rename over a target.
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

/// Converts native filesystem paths to the stable form used by IPC and JSON.
/// `canonicalize` returns Windows verbatim paths (`\\?\C:\...` or
/// `\\?\UNC\server\share`) which native dialogs and the web UI should not
/// expose. Internally callers may retain the canonical `PathBuf`.
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub(crate) fn path_to_string(path: &Path) -> String {
    strip_windows_verbatim_prefix(&path.to_string_lossy())
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
}

/// Windows CUDA probing runs outside `AsrManager` and needs the same root the
/// on-demand ASR runtime is staged into.
#[cfg(windows)]
pub fn application_data_root() -> Option<PathBuf> {
    if let Some(root) = PROCESS_APP_DATA_ROOT.get() {
        return Some(root.clone());
    }
    AppDataStorage::resolve().ok().map(|(root, _)| root)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use uuid::Uuid;

    use super::{
        AppDataBootstrap, AppDataStorage, AppDataStorageState, install_root_from_executable,
        prepare_data_root, read_bootstrap, select_initial_root, strip_windows_verbatim_prefix,
        write_bootstrap,
    };

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
    fn missing_bootstrap_uses_default_directory() {
        let base = temp_directory("default");
        let default_root = base.join("install");
        let bootstrap = base.join("config").join("app-data-bootstrap.json");
        std::fs::create_dir_all(&default_root).unwrap();

        let selected = select_initial_root(&default_root, &bootstrap).unwrap();
        assert_eq!(selected, default_root);

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn storage_selection_reports_restart_until_restored_to_current_default() {
        let base = temp_directory("selection");
        let default_root = base.join("install");
        let custom_root = base.join("custom ");
        let bootstrap = base.join("config").join("app-data-bootstrap.json");
        std::fs::create_dir_all(&default_root).unwrap();
        let default_root = std::fs::canonicalize(default_root).unwrap();
        let storage = AppDataStorage {
            state: Arc::new(Mutex::new(AppDataStorageState {
                current_root: default_root.clone(),
                default_root: default_root.clone(),
                selected_root: default_root.clone(),
                bootstrap_path: bootstrap.clone(),
            })),
        };

        let selected = storage
            .set_path(Some(custom_root.to_string_lossy().into_owned()))
            .unwrap();
        assert_eq!(selected.current_path, super::path_to_string(&default_root));
        assert_eq!(
            selected.path,
            super::path_to_string(&std::fs::canonicalize(custom_root).unwrap())
        );
        assert!(!selected.is_default);
        assert!(selected.restart_required);
        assert!(
            read_bootstrap(&bootstrap)
                .unwrap()
                .unwrap()
                .custom_path
                .is_some()
        );

        let restored = storage.set_path(None).unwrap();
        assert_eq!(restored.path, restored.current_path);
        assert!(restored.is_default);
        assert!(!restored.restart_required);
        assert_eq!(
            read_bootstrap(&bootstrap).unwrap().unwrap().custom_path,
            None
        );

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn configured_unavailable_directory_stops_startup_instead_of_falling_back() {
        let base = temp_directory("unavailable");
        let default_root = base.join("install");
        let bootstrap = base.join("config").join("app-data-bootstrap.json");
        let blocking_file = base.join("not-a-directory");
        let configured = blocking_file.join("custom");
        std::fs::create_dir_all(&default_root).unwrap();
        std::fs::write(&blocking_file, b"file").unwrap();
        write_bootstrap(&bootstrap, Some(&configured)).unwrap();

        let error = select_initial_root(&default_root, &bootstrap).unwrap_err();
        assert_eq!(error.code, "app_data_path_unavailable");
        assert!(error.message.contains("为避免创建分叉数据"));

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn corrupt_bootstrap_stops_startup_with_a_config_error() {
        let base = temp_directory("corrupt");
        let default_root = base.join("install");
        let bootstrap = base.join("config").join("app-data-bootstrap.json");
        std::fs::create_dir_all(&default_root).unwrap();
        std::fs::create_dir_all(bootstrap.parent().unwrap()).unwrap();
        std::fs::write(&bootstrap, b"not-json").unwrap();

        let error = select_initial_root(&default_root, &bootstrap).unwrap_err();
        assert_eq!(error.code, "app_data_config_error");
        assert!(error.message.contains("恢复应用数据目录引导配置失败"));

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn unreadable_bootstrap_stops_startup_with_a_config_error() {
        let base = temp_directory("unreadable");
        let default_root = base.join("install");
        let bootstrap = base.join("config").join("app-data-bootstrap.json");
        std::fs::create_dir_all(&default_root).unwrap();
        std::fs::create_dir_all(&bootstrap).unwrap();

        let error = select_initial_root(&default_root, &bootstrap).unwrap_err();
        assert_eq!(error.code, "app_data_config_error");
        assert!(error.message.contains("恢复应用数据目录引导配置失败"));

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn interrupted_bootstrap_replacement_restores_the_committed_backup() {
        let base = temp_directory("bootstrap-recovery");
        let bootstrap = base.join("config").join("app-data-bootstrap.json");
        let committed = base.join("committed");
        let uncommitted = base.join("uncommitted");
        write_bootstrap(&bootstrap, Some(&committed)).unwrap();
        let temporary = bootstrap.with_file_name("app-data-bootstrap.json.tmp");
        let backup = bootstrap.with_file_name("app-data-bootstrap.json.bak");
        std::fs::rename(&bootstrap, &backup).unwrap();
        std::fs::write(
            &temporary,
            serde_json::to_vec_pretty(&AppDataBootstrap {
                custom_path: Some(super::path_to_string(&uncommitted)),
            })
            .unwrap(),
        )
        .unwrap();

        let recovered = read_bootstrap(&bootstrap).unwrap().unwrap();
        assert_eq!(
            recovered.custom_path,
            Some(super::path_to_string(&committed))
        );
        assert!(!temporary.exists());
        assert!(!backup.exists());

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn initial_bootstrap_publish_recovers_a_valid_temporary_file() {
        let base = temp_directory("bootstrap-temporary");
        let bootstrap = base.join("config").join("app-data-bootstrap.json");
        let configured = base.join("configured");
        let temporary = bootstrap.with_file_name("app-data-bootstrap.json.tmp");
        std::fs::create_dir_all(temporary.parent().unwrap()).unwrap();
        std::fs::write(
            &temporary,
            serde_json::to_vec_pretty(&AppDataBootstrap {
                custom_path: Some(super::path_to_string(&configured)),
            })
            .unwrap(),
        )
        .unwrap();

        let recovered = read_bootstrap(&bootstrap).unwrap().unwrap();
        assert_eq!(
            recovered.custom_path,
            Some(super::path_to_string(&configured))
        );
        assert!(bootstrap.exists());
        assert!(!temporary.exists());

        std::fs::remove_dir_all(base).unwrap();
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
