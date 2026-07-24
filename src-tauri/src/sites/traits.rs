use crate::error::AppResult;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveSubCategory, PlayUrl, RoomListPage,
};

#[async_trait::async_trait]
pub trait LiveSite: Send + Sync {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>>;
    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage>;
    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage>;
    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage>;
    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail>;
    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>>;
    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>>;
    async fn get_live_status(&self, room_id: &str) -> AppResult<bool>;
}

/// Shared stub error for sites not yet implemented.
pub fn not_implemented(site: &str, method: &str) -> crate::error::AppError {
    crate::error::AppError::new(
        "not_implemented",
        format!("{site}::{method} is not implemented yet"),
    )
    .with_site(site)
}
