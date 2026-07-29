use crate::error::AppResult;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomStatus, LiveSubCategory, PlayUrl,
    RoomListPage,
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
    /// Fetch only the data needed to refresh a followed room's live state.
    ///
    /// Implementations must not call `get_room_detail`: the latter may resolve
    /// playback metadata or danmaku session information that a follow list
    /// neither displays nor needs.
    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus>;
    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail>;
    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>>;
    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>>;
    /// Returns an in-memory session Cookie suitable for a site-owned danmaku
    /// connection, when the site has one.
    ///
    /// Most platforms do not need this. Douyin may obtain transient browser
    /// cookies such as `ttwid` while resolving the room; the WSS handshake
    /// needs that same session on the Cookie header.
    /// Callers must keep this value inside the backend; it is never part of a
    /// serialised room detail or persisted account record.
    fn danmaku_session_cookie(&self) -> AppResult<Option<String>> {
        Ok(None)
    }
}
