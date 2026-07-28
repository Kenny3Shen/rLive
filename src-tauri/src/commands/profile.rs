use std::io::Write;

use tauri::{AppHandle, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use crate::error::{AppError, AppResult};
use crate::profile::{self, ProfileImportResult};
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
}

#[tauri::command]
pub fn profile_export(app: AppHandle, state: State<'_, AppState>, path: FilePath) -> AppResult<()> {
    let path_display = path.to_string();
    let conn = lock_db(&state)?;
    let package = profile::export_package(&conn)?;
    let text = profile::encode_package(&package)?;
    drop(conn);

    let mut options = OpenOptions::new();
    options.write(true).truncate(true).create(true);
    let mut file = app.fs().open(path, options).map_err(|e| {
        AppError::new(
            "profile_io_error",
            format!("open {} for writing: {e}", path_display),
        )
    })?;
    file.write_all(text.as_bytes())
        .and_then(|()| file.flush())
        .map_err(|e| AppError::new("profile_io_error", format!("write {}: {e}", path_display)))
}

#[tauri::command]
pub fn profile_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: FilePath,
) -> AppResult<ProfileImportResult> {
    let path_display = path.to_string();
    let mut options = OpenOptions::new();
    options.read(true);
    let file = app.fs().open(path, options).map_err(|e| {
        AppError::new(
            "profile_io_error",
            format!("open {} for reading: {e}", path_display),
        )
    })?;
    let mut conn = lock_db(&state)?;
    profile::import_package_reader(&mut conn, file)
}
