use serde::Serialize;
use tauri::State;

use crate::account;
use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveSubCategory, PlayUrl, RoomListPage, SiteId,
};
use crate::sites;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct SiteInfo {
    pub id: SiteId,
    pub name: String,
}

fn resolve_site(state: &AppState, site_id: &SiteId) -> AppResult<Box<dyn sites::traits::LiveSite>> {
    // 一个站点实例可能发起多个相互依赖的请求（Twitch bootstrap、GraphQL、
    // 房间数据，然后是它的 HLS master playlist）。把 cookie 和代理一起快照，
    // 使这条链上的每个请求都遵循同一份设置。
    let (cookie, proxy) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
        (
            account::get_cookie(&conn, site_id)?,
            crate::settings::get(&conn)?.proxy,
        )
    };
    sites::site_with_proxy(site_id, cookie, proxy.as_deref())
}

#[tauri::command]
pub fn site_list() -> Vec<SiteInfo> {
    sites::all_meta()
        .into_iter()
        .map(|s| SiteInfo {
            id: s.id.clone(),
            name: s.name.to_string(),
        })
        .collect()
}

#[tauri::command]
pub async fn site_get_categories(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<Vec<LiveCategory>> {
    let site = resolve_site(&state, &site_id)?;
    site.get_categories().await
}

#[tauri::command]
pub async fn site_get_recommend(
    state: State<'_, AppState>,
    site_id: SiteId,
    page: u32,
) -> AppResult<RoomListPage> {
    let site = resolve_site(&state, &site_id)?;
    site.get_recommend_rooms(page).await
}

#[tauri::command]
pub async fn site_get_category_rooms(
    state: State<'_, AppState>,
    site_id: SiteId,
    category: LiveSubCategory,
    page: u32,
) -> AppResult<RoomListPage> {
    let site = resolve_site(&state, &site_id)?;
    site.get_category_rooms(&category, page).await
}

#[tauri::command]
pub async fn site_search_rooms(
    state: State<'_, AppState>,
    site_id: SiteId,
    keyword: String,
    page: u32,
) -> AppResult<RoomListPage> {
    let site = resolve_site(&state, &site_id)?;
    site.search_rooms(&keyword, page).await
}

#[tauri::command]
pub async fn site_get_room_detail(
    state: State<'_, AppState>,
    site_id: SiteId,
    room_id: String,
) -> AppResult<LiveRoomDetail> {
    let site = resolve_site(&state, &site_id)?;
    site.get_room_detail(&room_id).await
}

#[tauri::command]
pub async fn site_get_play_qualities(
    state: State<'_, AppState>,
    site_id: SiteId,
    detail: LiveRoomDetail,
) -> AppResult<Vec<LivePlayQuality>> {
    let site = resolve_site(&state, &site_id)?;
    site.get_play_qualities(&detail).await
}

#[tauri::command]
pub async fn site_get_play_urls(
    state: State<'_, AppState>,
    site_id: SiteId,
    detail: LiveRoomDetail,
    quality: LivePlayQuality,
) -> AppResult<Vec<PlayUrl>> {
    let site = resolve_site(&state, &site_id)?;
    site.get_play_urls(&detail, &quality).await
}
