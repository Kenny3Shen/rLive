use tauri::{AppHandle, State};

use crate::account;
use crate::danmaku;
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::sites;
use crate::state::AppState;

fn load_cookie(state: &AppState, site_id: &SiteId) -> AppResult<Option<String>> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
    account::get_cookie(&conn, site_id)
}

#[tauri::command]
pub async fn danmaku_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    site_id: SiteId,
    room_id: String,
) -> AppResult<()> {
    let cookie = load_cookie(&state, &site_id)?;
    let site = sites::site(&site_id, cookie)?;
    let detail = site.get_room_detail(&room_id).await?;
    danmaku::connect(app, &state.danmaku, site_id, &room_id, &detail.raw).await
}

#[tauri::command]
pub fn danmaku_disconnect(state: State<'_, AppState>) -> AppResult<()> {
    state.danmaku.disconnect();
    Ok(())
}
