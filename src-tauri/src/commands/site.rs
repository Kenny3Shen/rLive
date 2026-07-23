use serde::Serialize;

use crate::error::AppResult;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveSubCategory, PlayUrl, RoomListPage, SiteId,
};
use crate::sites;

#[derive(Debug, Clone, Serialize)]
pub struct SiteInfo {
    pub id: SiteId,
    pub name: String,
    pub ready: bool,
}

#[tauri::command]
pub fn site_list() -> Vec<SiteInfo> {
    sites::all()
        .into_iter()
        .map(|s| SiteInfo {
            id: s.id(),
            name: s.name().to_string(),
            ready: sites::is_ready(&s.id()),
        })
        .collect()
}

#[tauri::command]
pub async fn site_get_categories(site_id: SiteId) -> AppResult<Vec<LiveCategory>> {
    let site = sites::site(&site_id)?;
    site.get_categories().await
}

#[tauri::command]
pub async fn site_get_recommend(site_id: SiteId, page: u32) -> AppResult<RoomListPage> {
    let site = sites::site(&site_id)?;
    site.get_recommend_rooms(page).await
}

#[tauri::command]
pub async fn site_get_category_rooms(
    site_id: SiteId,
    category: LiveSubCategory,
    page: u32,
) -> AppResult<RoomListPage> {
    let site = sites::site(&site_id)?;
    site.get_category_rooms(&category, page).await
}

#[tauri::command]
pub async fn site_search_rooms(
    site_id: SiteId,
    keyword: String,
    page: u32,
) -> AppResult<RoomListPage> {
    let site = sites::site(&site_id)?;
    site.search_rooms(&keyword, page).await
}

#[tauri::command]
pub async fn site_get_room_detail(site_id: SiteId, room_id: String) -> AppResult<LiveRoomDetail> {
    let site = sites::site(&site_id)?;
    site.get_room_detail(&room_id).await
}

#[tauri::command]
pub async fn site_get_play_qualities(
    site_id: SiteId,
    detail: LiveRoomDetail,
) -> AppResult<Vec<LivePlayQuality>> {
    let site = sites::site(&site_id)?;
    site.get_play_qualities(&detail).await
}

#[tauri::command]
pub async fn site_get_play_urls(
    site_id: SiteId,
    detail: LiveRoomDetail,
    quality: LivePlayQuality,
) -> AppResult<Vec<PlayUrl>> {
    let site = sites::site(&site_id)?;
    site.get_play_urls(&detail, &quality).await
}
