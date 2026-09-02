use tauri::State;

use crate::db::danmaku_favorite::{self, DanmakuFavoriteRecord};
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::state::AppState;

/// 列出为某个发送平台刻意保存的可复用消息。这些记录仅存于本机，
/// 且不受清空发送历史的影响。
#[tauri::command]
pub fn danmaku_favorite_list(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<Vec<DanmakuFavoriteRecord>> {
    let conn = state.conn()?;
    danmaku_favorite::list(&conn, site_id.as_str())
}

/// 保存一条可复用的发送消息。时间戳在本地生成，
/// 因此调用方无法重排收藏顺序或注入过期记录。
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
    let conn = state.conn()?;
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
    let conn = state.conn()?;
    danmaku_favorite::remove(&conn, site_id.as_str(), content)
}
