use crate::error::AppResult;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveSubCategory, PlayUrl, RoomListPage, SiteId,
};
use crate::sites::traits::{not_implemented, LiveSite};

pub struct HuyaSite;

#[async_trait::async_trait]
impl LiveSite for HuyaSite {
    fn id(&self) -> SiteId {
        SiteId::Huya
    }

    fn name(&self) -> &'static str {
        "Huya"
    }

    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        Err(not_implemented("huya", "get_categories"))
    }

    async fn get_recommend_rooms(&self, _page: u32) -> AppResult<RoomListPage> {
        Err(not_implemented("huya", "get_recommend_rooms"))
    }

    async fn get_category_rooms(
        &self,
        _category: &LiveSubCategory,
        _page: u32,
    ) -> AppResult<RoomListPage> {
        Err(not_implemented("huya", "get_category_rooms"))
    }

    async fn search_rooms(&self, _keyword: &str, _page: u32) -> AppResult<RoomListPage> {
        Err(not_implemented("huya", "search_rooms"))
    }

    async fn get_room_detail(&self, _room_id: &str) -> AppResult<LiveRoomDetail> {
        Err(not_implemented("huya", "get_room_detail"))
    }

    async fn get_play_qualities(&self, _detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        Err(not_implemented("huya", "get_play_qualities"))
    }

    async fn get_play_urls(
        &self,
        _detail: &LiveRoomDetail,
        _quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        Err(not_implemented("huya", "get_play_urls"))
    }

    async fn get_live_status(&self, _room_id: &str) -> AppResult<bool> {
        Err(not_implemented("huya", "get_live_status"))
    }
}
