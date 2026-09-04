use tauri::State;

use crate::db::video_history::{self, VideoHistoryRecord};
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub fn video_history_list(state: State<'_, AppState>) -> AppResult<Vec<VideoHistoryRecord>> {
    let conn = state.conn()?;
    video_history::list(&conn)
}

#[tauri::command]
pub fn video_history_find(
    state: State<'_, AppState>,
    kind: String,
    oid: String,
) -> AppResult<Option<VideoHistoryRecord>> {
    let conn = state.conn()?;
    video_history::find(&conn, &kind, &oid)
}

#[tauri::command]
pub fn video_history_add(state: State<'_, AppState>, item: VideoHistoryRecord) -> AppResult<()> {
    let conn = state.conn()?;
    video_history::upsert(&conn, item)
}

#[tauri::command]
pub fn video_history_remove(
    state: State<'_, AppState>,
    kind: String,
    oid: String,
) -> AppResult<()> {
    let conn = state.conn()?;
    video_history::remove(&conn, &kind, &oid)
}

#[tauri::command]
pub fn video_history_clear(state: State<'_, AppState>) -> AppResult<()> {
    let conn = state.conn()?;
    video_history::clear(&conn)
}
