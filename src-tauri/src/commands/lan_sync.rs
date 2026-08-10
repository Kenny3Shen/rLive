use std::io::Cursor;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::lan_sync::{LanSyncSessionInfo, receive_profile};
use crate::profile::{self, ProfileImportResult};
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
}

#[tauri::command(async)]
pub async fn lan_sync_start(state: State<'_, AppState>) -> AppResult<LanSyncSessionInfo> {
    let profile = {
        let conn = lock_db(&state)?;
        let package = profile::export_package(&conn)?;
        profile::encode_package(&package)?
    };
    state.lan_sync.start(profile).await
}

#[tauri::command]
pub fn lan_sync_status(state: State<'_, AppState>) -> AppResult<Option<LanSyncSessionInfo>> {
    state.lan_sync.status()
}

#[tauri::command]
pub fn lan_sync_stop(state: State<'_, AppState>) {
    state.lan_sync.stop();
}

#[tauri::command(async)]
pub async fn lan_sync_receive(
    state: State<'_, AppState>,
    address: String,
    code: String,
) -> AppResult<ProfileImportResult> {
    let bytes = receive_profile(&address, &code).await?;
    let mut conn = lock_db(&state)?;
    profile::import_package_reader(&mut conn, Cursor::new(bytes))
}
