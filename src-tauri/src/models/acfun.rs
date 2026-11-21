//! AcFun 视频与文章跨 IPC 数据模型。
//!
//! AcFun 的稿件使用 `dougaId`，文章使用 `articleId`，两者都与 Bilibili 的
//! BV/CID 或直播间号无关。这里刻意使用独立模型，避免把 B 站专属字段带进
//! AcFun 页面。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunVideoItem {
    /// 文章型视频在列表中仍以 `dougaId` 作为详情与播放标识。
    pub id: String,
    pub title: String,
    pub cover: String,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_avatar: Option<String>,
    pub duration_sec: u64,
    pub play_count: u64,
    pub danmaku_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_count: Option<u64>,
    /// Unix 秒；上游未提供时为 0。
    pub published_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunVideoListPage {
    pub items: Vec<AcfunVideoItem>,
    pub has_more: bool,
    /// 下一次请求使用的页码；列表输入页为 1-based。
    pub next_page: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunVideoSection {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunVideoPart {
    /// 上游分 P 的内部 `videoId`，播放命令原样回传。
    pub id: String,
    /// 从 1 开始的展示序号。
    pub index: u32,
    pub title: String,
    pub duration_sec: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunVideoDetail {
    pub item: AcfunVideoItem,
    pub description: String,
    pub tags: Vec<String>,
    pub parts: Vec<AcfunVideoPart>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AcfunCommentSort {
    Hot,
    #[default]
    Time,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunVideoComment {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub content: String,
    /// Unix 秒。
    pub created_at: u64,
    pub like_count: u64,
    pub is_uploader: bool,
    pub pictures: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_name: Option<String>,
    /// 一级评论的首屏回复预览；回复项自身始终为空。
    pub replies: Vec<AcfunVideoComment>,
    pub reply_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunCommentPage {
    pub items: Vec<AcfunVideoComment>,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_page: Option<u32>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunCommentReplyPage {
    pub items: Vec<AcfunVideoComment>,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunVideoQuality {
    /// 上游稳定的画质类型，例如 `1080p60`。
    pub id: String,
    pub label: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunVideoPlayInfo {
    /// 已转发的本机 HLS URL。
    pub url: String,
    pub quality: String,
    pub quality_label: String,
    /// 当前 AcFun VOD 均为 HLS；保留字段以便前端按既有播放器能力分支。
    pub protocol: String,
    pub accept_qualities: Vec<AcfunVideoQuality>,
    /// 交给 WebView 媒体元素时使用的请求头；该 URL 已经过本机代理。
    pub headers: HashMap<String, String>,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcfunVideoDanmakuItem {
    pub id: String,
    /// 相对视频开头的出现时间，毫秒。
    pub progress: u64,
    pub mode: u32,
    pub size: u32,
    pub color: u32,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunArticleChannel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunArticleItem {
    pub id: String,
    pub title: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    pub view_count: u64,
    pub comment_count: u64,
    /// Unix 秒；上游未提供时为 0。
    pub published_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunArticleListPage {
    pub items: Vec<AcfunArticleItem>,
    pub has_more: bool,
    /// 上游不公开可随机访问的页码，下一次加载必须带回本游标。
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcfunArticleInline {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "is_false")]
        bold: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        italic: bool,
    },
    Link {
        text: String,
        url: String,
        #[serde(default, skip_serializing_if = "is_false")]
        bold: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        italic: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcfunArticleBlock {
    Paragraph {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        inlines: Vec<AcfunArticleInline>,
    },
    Heading {
        level: u8,
        text: String,
    },
    Image {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alt: Option<String>,
    },
    Link {
        text: String,
        url: String,
    },
    Quote {
        text: String,
    },
    List {
        ordered: bool,
        items: Vec<String>,
    },
    Code {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
    },
    Divider,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcfunArticleDetail {
    pub item: AcfunArticleItem,
    pub tags: Vec<String>,
    pub blocks: Vec<AcfunArticleBlock>,
}

fn is_false(value: &bool) -> bool {
    !*value
}
