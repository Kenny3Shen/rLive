//! YouTube 公开直播站点客户端。
//!
//! 浏览使用匿名 Innertube Web 客户端，播放使用匿名 Android 客户端返回的
//! HLS master playlist。全部请求沿用户当前的代理路由发出；不保存或透传
//! Cookie。签名媒体地址只通过既有播放契约传给本机代理。

mod api;
mod parse;
mod playback;
mod room;

use reqwest::Client;

use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomStatus, LiveSubCategory, PlayUrl,
    RoomListPage, SiteId,
};
use crate::proxy::ProxyRoute;
use crate::sites::traits::LiveSite;

use room::canonical_url;

/// 已注册的 YouTube 直播站点后端。
pub struct YoutubeSite {
    client: Client,
    site_id: SiteId,
    route: ProxyRoute,
}

impl YoutubeSite {
    pub fn new(client: Client, route: ProxyRoute) -> Self {
        Self {
            client,
            site_id: SiteId::Youtube,
            route,
        }
    }

    fn err(code: &str, message: impl Into<String>) -> AppError {
        AppError::new(code, message).with_site("youtube")
    }

    fn upstream_err(message: impl Into<String>) -> AppError {
        Self::err("youtube_upstream_error", message).retryable()
    }

    fn parse_err(message: impl Into<String>) -> AppError {
        Self::err("youtube_parse_error", message)
    }
}

#[async_trait::async_trait]
impl LiveSite for YoutubeSite {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        Ok(api::categories())
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        self.search_live("直播", page).await
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        let query = api::category_query(&category.id).unwrap_or("直播");
        self.search_live(query, page).await
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        if canonical_url(keyword).is_some() {
            if page > 1 {
                return Ok(RoomListPage::empty());
            }
            let detail = self.room_detail(keyword).await?;
            return Ok(RoomListPage {
                has_more: false,
                items: vec![crate::models::live::LiveRoomItem {
                    site_id: detail.site_id,
                    room_id: detail.room_id,
                    title: detail.title,
                    cover: detail.cover,
                    user_name: detail.user_name,
                    online: detail.online,
                    live_status: Some(detail.status),
                }],
            });
        }
        self.search_live(keyword, page).await
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
