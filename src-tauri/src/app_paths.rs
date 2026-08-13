use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct AppDirectories {
    pub root: PathBuf,
    pub logs: PathBuf,
    #[cfg(windows)]
    pub webview: PathBuf,
}

impl AppDirectories {
    pub fn resolve(mobile_data_dir: Option<&Path>) -> AppResult<Self> {
        let root = application_root(mobile_data_dir)?;
        #[cfg(windows)]
        migrate_legacy_windows_data(&root)?;
        fs::create_dir_all(&root).map_err(|error| {
            AppError::new(
                "app_data_dir_error",
                format!("create application directory {}: {error}", root.display()),
            )
        })?;
        Ok(Self {
            logs: root.join("logs"),
            #[cfg(windows)]
            webview: root.join("webview"),
            root,
        })
    }
}

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

#[cfg(windows)]
fn application_root(_mobile_data_dir: Option<&Path>) -> AppResult<PathBuf> {
    let executable_dir = std::env::current_exe()
        .map_err(|error| {
            AppError::new(
                "app_data_dir_error",
                format!("resolve executable path: {error}"),
            )
        })?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            AppError::new("app_data_dir_error", "executable directory is unavailable")
        })?;

    // 便携版把数据放在 EXE 同级目录；通过 NSIS/MSI 安装的副本（安装目录含
    // uninstall.exe，或位于 Program Files 等不可写位置）改用用户数据目录，
    // 避免升级/卸载清理安装目录时丢失数据。
    let is_installed_copy = executable_dir.join("uninstall.exe").is_file();
    if !is_installed_copy && directory_is_writable(&executable_dir) {
        return Ok(executable_dir);
    }
    Ok(dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("rlive"))
}

#[cfg(windows)]
fn directory_is_writable(directory: &Path) -> bool {
    let probe = directory.join(format!(".rlive-write-probe-{}", std::process::id()));
    let created = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .is_ok();
    if created {
        let _ = fs::remove_file(&probe);
    }
    created
}

#[cfg(not(any(windows, target_os = "android")))]
fn application_root(_mobile_data_dir: Option<&Path>) -> AppResult<PathBuf> {
    Ok(dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("rlive"))
}

#[cfg(windows)]
fn migrate_legacy_windows_data(destination: &Path) -> AppResult<()> {
    if let Some(source) = dirs::data_dir().map(|directory| directory.join("rlive"))
        && source.is_dir()
        && !paths_refer_to_same_location(&source, destination)
    {
        for name in ["rlive.db", "rlive.db-wal", "rlive.db-shm", "models", "logs"] {
            migrate_path_if_missing(&source.join(name), &destination.join(name)).map_err(
                |error| {
                    AppError::new(
                        "app_data_migration_error",
                        format!("migrate legacy application data: {error}"),
                    )
                },
            )?;
        }
    }

    if let Some(source) = dirs::data_local_dir().map(|directory| directory.join("com.shenss.rlive"))
        && source.is_dir()
        && !paths_refer_to_same_location(&source, &destination.join("webview"))
        && !destination.starts_with(&source)
    {
        migrate_path_if_missing(&source, &destination.join("webview")).map_err(|error| {
            AppError::new(
                "app_data_migration_error",
                format!("migrate legacy WebView data: {error}"),
            )
        })?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn migrate_path_if_missing(source: &Path, destination: &Path) -> std::io::Result<()> {
    if !source.exists() || destination.exists() {
        return Ok(());
    }
    if let Err(error) = copy_path(source, destination) {
        let _ = remove_path(destination);
        return Err(error);
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn copy_path(source: &Path, destination: &Path) -> std::io::Result<()> {
    if source.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
        return Ok(());
    }

    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        copy_path(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn remove_path(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(windows)]
fn paths_refer_to_same_location(left: &Path, right: &Path) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::migrate_path_if_missing;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "rlive-app-paths-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn migrates_files_and_nested_directories() {
        let root = test_directory("copy");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("rlive.db"), b"database").unwrap();
        fs::write(source.join("nested/model.onnx"), b"model").unwrap();

        migrate_path_if_missing(&source, &destination).unwrap();

        assert_eq!(fs::read(destination.join("rlive.db")).unwrap(), b"database");
        assert_eq!(
            fs::read(destination.join("nested/model.onnx")).unwrap(),
            b"model"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_an_existing_destination() {
        let root = test_directory("preserve");
        let source = root.join("source.txt");
        let destination = root.join("destination.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&source, b"legacy").unwrap();
        fs::write(&destination, b"current").unwrap();

        migrate_path_if_missing(&source, &destination).unwrap();

        assert_eq!(fs::read(destination).unwrap(), b"current");
        fs::remove_dir_all(root).unwrap();
    }
}
