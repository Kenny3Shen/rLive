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
    /// 只拉取刷新关注房间直播状态所需的数据。
    ///
    /// 实现不得调用 `get_room_detail`：后者可能解析播放元数据或弹幕会话信息，
    /// 而关注列表既不展示也不需要它们。
    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus>;
    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail>;
    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>>;
    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>>;
    /// 当站点拥有自己的弹幕连接时，返回适合它的内存态会话 Cookie。
    ///
    /// 大多数平台不需要这一步。抖音在解析房间时可能获得 `ttwid` 等临时浏览器
    /// cookie；WSS 握手需要在 Cookie 头里带上同一份会话。
    /// 调用方必须把这个值留在后端内部；
    /// 它绝不会出现在序列化的房间详情或持久化的账号记录中。
    fn danmaku_session_cookie(&self) -> AppResult<Option<String>> {
        Ok(None)
    }
}
