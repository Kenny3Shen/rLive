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

/// 返回某平台最近确认发送的消息。发出的内容仅存于本机，
/// 且刻意不纳入配置的导出/导入。
#[tauri::command]
pub fn danmaku_send_history_list(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<Vec<DanmakuSendHistoryRecord>> {
    let conn = lock_db(&state)?;
    danmaku_send_history::list(&conn, site_id.as_str())
}

/// 为历史界面返回所有受支持平台的发送弹幕。
/// 数据仅存于本地，不会离开本设备。
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
