use tauri::State;

use crate::error::{AppError, AppResult};
use crate::profile::{self, ProfileImportResult};
use crate::state::AppState;
use std::path::PathBuf;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
}

#[tauri::command]
pub fn profile_export(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let conn = lock_db(&state)?;
    let package = profile::export_package(&conn)?;
    profile::write_package(&PathBuf::from(path), &package)
}

#[tauri::command]
pub fn profile_import(state: State<'_, AppState>, path: String) -> AppResult<ProfileImportResult> {
    let conn = lock_db(&state)?;
    profile::import_package(&conn, &PathBuf::from(path))
}
