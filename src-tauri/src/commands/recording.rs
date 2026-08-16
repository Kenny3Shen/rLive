//! Tauri commands for desktop recording and the local recording library.

#![cfg(not(target_os = "android"))]

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::recording::{RecordingItem, RecordingStartInput, RecordingStorageInfo};
use crate::state::AppState;

fn configured_proxy(state: &AppState) -> AppResult<Option<String>> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
    Ok(crate::settings::get(&conn)?.proxy)
}

#[tauri::command]
pub fn recording_list(state: State<'_, AppState>) -> AppResult<Vec<RecordingItem>> {
    state.recording.list()
}

#[tauri::command(async)]
pub async fn recording_start(
    state: State<'_, AppState>,
    input: RecordingStartInput,
) -> AppResult<RecordingItem> {
    let proxy = configured_proxy(state.inner())?;
    state.recording.start(input, proxy.as_deref()).await
}

#[tauri::command(async)]
pub async fn recording_stop(state: State<'_, AppState>, id: String) -> AppResult<RecordingItem> {
    state.recording.stop(id.trim()).await
}

#[tauri::command]
pub fn recording_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.recording.delete(id.trim())
}

#[tauri::command(async)]
pub async fn recording_playback_url(state: State<'_, AppState>, id: String) -> AppResult<String> {
    state.recording.playback_url(id.trim()).await
}

#[tauri::command]
pub fn recording_storage_path(state: State<'_, AppState>) -> AppResult<String> {
    Ok(state.recording.storage_path())
}

#[tauri::command]
pub fn recording_storage_info(state: State<'_, AppState>) -> AppResult<RecordingStorageInfo> {
    Ok(state.recording.storage_info())
}

#[tauri::command]
pub fn recording_set_storage_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> AppResult<RecordingStorageInfo> {
    state.recording.set_storage_path(path)
}

#[tauri::command(async)]
pub async fn recording_danmaku_url(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Option<String>> {
    state.recording.danmaku_url(id.trim()).await
}
