use tauri::State;

use crate::db::danmaku_favorite::{self, DanmakuFavoriteRecord};
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
}

/// Lists reusable messages deliberately saved for one sending platform. These
/// records remain device-local and are not tied to clearing send history.
#[tauri::command]
pub fn danmaku_favorite_list(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<Vec<DanmakuFavoriteRecord>> {
    let conn = lock_db(&state)?;
    danmaku_favorite::list(&conn, site_id.as_str())
}

/// Saves one reusable outgoing message. The timestamp is created locally so
/// callers cannot reorder favorites or inject a stale record.
#[tauri::command]
pub fn danmaku_favorite_add(
    state: State<'_, AppState>,
    site_id: SiteId,
    content: String,
) -> AppResult<()> {
    let content = content.trim();
    if content.is_empty() {
        return Err(AppError::new(
            "invalid_danmaku_favorite",
            "content is empty",
        ));
    }
    let conn = lock_db(&state)?;
    danmaku_favorite::upsert(
        &conn,
        site_id.as_str(),
        content,
        chrono::Utc::now().timestamp_millis(),
    )
}

#[tauri::command]
pub fn danmaku_favorite_remove(
    state: State<'_, AppState>,
    site_id: SiteId,
    content: String,
) -> AppResult<()> {
    let content = content.trim();
    if content.is_empty() {
        return Err(AppError::new(
            "invalid_danmaku_favorite",
            "content is empty",
        ));
    }
    let conn = lock_db(&state)?;
    danmaku_favorite::remove(&conn, site_id.as_str(), content)
}
