use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct AppDirectories {
    pub root: PathBuf,
    pub logs: PathBuf,
}

impl AppDirectories {
    pub fn resolve(mobile_data_dir: Option<&Path>) -> AppResult<Self> {
        let root = application_root(mobile_data_dir)?;
        fs::create_dir_all(&root).map_err(|error| {
            AppError::new(
                "app_data_dir_error",
                format!("create application directory {}: {error}", root.display()),
            )
        })?;
        Ok(Self {
            logs: root.join("logs"),
            root,
        })
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

/// Desktop platforms keep the user-owned data directory (`%APPDATA%\rlive` on
/// Windows, `~/.local/share/rlive` on Linux, `~/Library/Application
/// Support/rlive` on macOS) so installing, upgrading or uninstalling the
/// application never touches local databases, models or logs.
#[cfg(not(target_os = "android"))]
fn application_root(_mobile_data_dir: Option<&Path>) -> AppResult<PathBuf> {
    Ok(dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("rlive"))
}

/// Windows CUDA probing runs outside `AsrManager` and needs the same root the
/// on-demand ASR runtime is staged into.
#[cfg(windows)]
pub fn application_data_root() -> Option<PathBuf> {
    application_root(None).ok()
}
