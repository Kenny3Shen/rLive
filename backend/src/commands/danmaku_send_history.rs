use tauri::State;

use crate::db::danmaku_send_history::{self, DanmakuSendHistoryRecord};
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
}

/// Returns the most recently confirmed messages for one platform. The
/// outgoing content remains device-local and is deliberately not part of
/// profile export/import.
#[tauri::command]
pub fn danmaku_send_history_list(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<Vec<DanmakuSendHistoryRecord>> {
    let conn = lock_db(&state)?;
    danmaku_send_history::list(&conn, site_id.as_str())
}

/// Returns outgoing danmaku across all supported platforms for the history
/// screen. The data is local-only and does not leave this device.
#[tauri::command]
pub fn danmaku_send_history_list_all(
    state: State<'_, AppState>,
) -> AppResult<Vec<DanmakuSendHistoryRecord>> {
    let conn = lock_db(&state)?;
    danmaku_send_history::list_all(&conn)
}

#[tauri::command]
pub fn danmaku_send_history_clear(state: State<'_, AppState>, site_id: SiteId) -> AppResult<()> {
    let conn = lock_db(&state)?;
    danmaku_send_history::clear(&conn, site_id.as_str())
}

#[tauri::command]
pub fn danmaku_send_history_clear_all(state: State<'_, AppState>) -> AppResult<()> {
    let conn = lock_db(&state)?;
    danmaku_send_history::clear_all(&conn)
}
