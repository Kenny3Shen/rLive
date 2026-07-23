use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SiteId {
    Bilibili,
    Huya,
    Douyu,
    Douyin,
    Kuaishou,
}

impl SiteId {
    pub fn as_str(&self) -> &'static str {
        match self {
            SiteId::Bilibili => "bilibili",
            SiteId::Huya => "huya",
            SiteId::Douyu => "douyu",
            SiteId::Douyin => "douyin",
            SiteId::Kuaishou => "kuaishou",
        }
    }

    pub fn from_str_loose(s: &str) -> Option<SiteId> {
        match s {
            "bilibili" => Some(SiteId::Bilibili),
            "huya" => Some(SiteId::Huya),
            "douyu" => Some(SiteId::Douyu),
            "douyin" => Some(SiteId::Douyin),
            "kuaishou" => Some(SiteId::Kuaishou),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveCategory {
    pub id: String,
    pub name: String,
    pub children: Vec<LiveSubCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveSubCategory {
    pub id: String,
    pub name: String,
    pub parent_id: String,
    pub pic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveRoomItem {
    pub site_id: SiteId,
    pub room_id: String,
    pub title: String,
    pub cover: String,
    pub user_name: String,
    pub online: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveRoomDetail {
    pub site_id: SiteId,
    pub room_id: String,
    pub title: String,
    pub cover: String,
    pub user_name: String,
    pub user_avatar: String,
    pub online: i64,
    pub status: bool,
    pub notice: String,
    pub url: String,
    /// Opaque site-specific payload needed for play-url requests (JSON string ok).
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayUrl {
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LivePlayQuality {
    pub quality: String,
    /// Data needed later for get_play_urls (site-specific); also list of ready urls if known.
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomListPage {
    pub has_more: bool,
    pub items: Vec<LiveRoomItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuKind {
    Chat,
    Gift,
    Enter,
    SuperChat,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DanmakuEvent {
    pub kind: DanmakuKind,
    pub user: String,
    pub content: String,
    pub color: Option<String>,
    pub ts: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_id_serializes_snake() {
        let s = serde_json::to_string(&SiteId::Bilibili).unwrap();
        assert_eq!(s, "\"bilibili\"");
    }
}
