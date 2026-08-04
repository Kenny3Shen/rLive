use tauri::State;

use crate::db::history::{self, HistoryRecord};
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
}

#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    site_id: Option<SiteId>,
) -> AppResult<Vec<HistoryRecord>> {
    let conn = lock_db(&state)?;
    match site_id {
        Some(site_id) => history::list_for_site(&conn, site_id.as_str()),
        None => history::list(&conn),
    }
}

#[tauri::command]
pub fn history_add(state: State<'_, AppState>, item: HistoryRecord) -> AppResult<()> {
    let conn = lock_db(&state)?;
    history::upsert(&conn, item)
}

#[tauri::command]
pub fn history_clear(state: State<'_, AppState>) -> AppResult<()> {
    let conn = lock_db(&state)?;
    history::clear(&conn)
}

#[tauri::command]
pub fn history_remove(
    state: State<'_, AppState>,
    site_id: String,
    room_id: String,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    history::remove(&conn, &site_id, &room_id)
}
