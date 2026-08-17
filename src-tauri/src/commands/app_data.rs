//! Application data directory settings. The selected path takes effect on the
//! next launch because SQLite, logs, models and recording state are initialized
//! before the frontend can invoke commands.

#![cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]

use tauri::State;

use crate::app_paths::AppDataStorageInfo;
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub fn app_data_storage_info(state: State<'_, AppState>) -> AppResult<AppDataStorageInfo> {
    Ok(state.app_data_storage.info())
}

#[tauri::command]
pub fn app_data_set_storage_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> AppResult<AppDataStorageInfo> {
    state.app_data_storage.set_path(path)
}
