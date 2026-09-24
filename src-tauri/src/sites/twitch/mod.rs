//! Twitch 公开 Web 直播站点客户端。
//!
//! Twitch 有文档记载的 Helix 接口需要应用级 OAuth 凭据，桌面客户端不得内嵌。
//! 本模块改为使用 `www.twitch.tv` 向匿名访客暴露的同一批公开 GraphQL 接口和
//! 播放引导数据。公开 Web 客户端 id 在运行时从引导文档中发现，
//! 既不硬编码也不持久化。
//!
//! 浏览按*语言分片*分页，而不是按 Relay 游标。除非请求来自通过了其 JS 完整性
//! 挑战的浏览器上下文，否则 Twitch 对任何 `after:` 游标都回答
//! `IntegrityCheckFailed`；而单纯的 `broadcasterLanguages` 过滤只需要公开的
//! 客户端 id。因此遍历语言列表即可达到相同深度：
//! 无需 token、无需隐藏 WebView，移动端行为也一致。

mod api;
mod browse;
mod hls;
mod parse;
mod playback;
mod room;

#[cfg(test)]
mod tests;

use reqwest::Client;

use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomStatus, LiveSubCategory, PlayUrl,
    RoomListPage, SiteId,
};
use crate::sites::traits::LiveSite;

pub use api::DEFAULT_USER_AGENT;
pub(crate) use playback::{
    TWITCH_AD_FALLBACK_PROFILES, TWITCH_PRIMARY_PLAYER_TYPE, twitch_ad_fallback_url,
};

/// 已注册的 Twitch 直播站点后端。
pub struct TwitchSite {
    client: Client,
    site_id: SiteId,
}

impl TwitchSite {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            site_id: SiteId::Twitch,
        }
    }

    fn err(message: impl Into<String>) -> AppError {
        AppError::new("twitch_api_error", message)
            .with_site("twitch")
            .retryable()
    }

    fn parse_err(message: impl Into<String>) -> AppError {
        AppError::new("twitch_parse_error", message).with_site("twitch")
    }
}

#[async_trait::async_trait]
impl LiveSite for TwitchSite {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        self.category_tree().await
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        self.recommend_page(page).await
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        self.category_page(category, page).await
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        self.search_page(keyword, page).await
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        self.room_live_status(room_id).await
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        self.room_detail(room_id).await
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        self.play_qualities(detail).await
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        self.play_urls(detail, quality).await
    }
}
