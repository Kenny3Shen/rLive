use serde::Serialize;

/// 抖音点播独立身份，不借用 B 站的 aid/bvid/cid。
#[derive(Debug, Serialize)]
pub struct DouyinVideoItem {
    pub id: String,
    pub title: String,
    pub author: String,
    pub cover: String,
    pub width: u64,
    pub height: u64,
    pub duration: f64,
    pub share_url: String,
}

#[derive(Debug, Serialize)]
pub struct DouyinVideoFeedPage {
    pub items: Vec<DouyinVideoItem>,
    /// 轮换批次而非分页游标；前端还须在全重复批次时停止。
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct DouyinVideoPlayback {
    pub item: DouyinVideoItem,
    pub play_url: String,
    pub session_id: String,
}
