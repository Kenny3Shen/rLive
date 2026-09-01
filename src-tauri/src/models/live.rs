use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SiteId {
    Bilibili,
    Huya,
    Douyu,
    Douyin,
    Twitch,
}

impl SiteId {
    pub fn as_str(&self) -> &'static str {
        match self {
            SiteId::Bilibili => "bilibili",
            SiteId::Huya => "huya",
            SiteId::Douyu => "douyu",
            SiteId::Douyin => "douyin",
            SiteId::Twitch => "twitch",
        }
    }

    pub fn from_str_loose(s: &str) -> Option<SiteId> {
        match s {
            "bilibili" => Some(SiteId::Bilibili),
            "huya" => Some(SiteId::Huya),
            "douyu" => Some(SiteId::Douyu),
            "douyin" => Some(SiteId::Douyin),
            "twitch" => Some(SiteId::Twitch),
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
    /// 该房间此刻是否在播。只有搜索这类会同时返回在播与未开播主播的接口才填充；
    /// 分类和推荐列表天然只含在播房间，保持 `None` 表示“平台未告知”，
    /// 调用方不得把 `None` 当成未开播。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_status: Option<bool>,
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
    /// 当前直播场次开始的 Unix 时间戳（毫秒）。并非所有平台都暴露该值，
    /// 调用方必须处理 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_started_at: Option<i64>,
    pub notice: String,
    pub url: String,
    /// 播放地址请求所需的、站点特有的不透明负载（JSON 字符串即可）。
    pub raw: serde_json::Value,
}

/// 关注列表使用的房间元数据中一小部分可安全刷新的字段。
///
/// 关注刷新既不需要播放地址，也不需要弹幕连接数据。把它独立成模型，
/// 可在站点客户端中让这条边界显式可见，
/// 避免一次无害的状态更新又膨胀成完整的房间详情请求。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveRoomStatus {
    pub status: bool,
    /// 当平台在轻量状态接口上提供该值时，保留直播场次开始时间，
    /// 供关注列表展示直播时长。
    pub live_started_at: Option<i64>,
}

/// 把各直播平台五花八门的开播时间表示转换为安全的 Unix 毫秒时间戳。
///
/// 国内平台通常发送中国标准时间字符串，其他服务则发送 epoch 时间戳或
/// RFC3339 值。超出合理直播时间范围的取值会被刻意丢弃，
/// 而不是显示一个误导性的时长。
pub fn parse_live_started_at(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    let parsed = match value {
        serde_json::Value::Number(number) => number.as_i64().and_then(normalize_epoch_millis),
        serde_json::Value::String(raw) => parse_live_started_at_string(raw),
        _ => None,
    }?;
    is_plausible_live_started_at(parsed).then_some(parsed)
}

fn normalize_epoch_millis(value: i64) -> Option<i64> {
    if value <= 0 {
        return None;
    }
    match value {
        // 依次尝试纳秒、微秒、毫秒，最后是秒。
        value if value >= 1_000_000_000_000_000_000 => value.checked_div(1_000_000),
        value if value >= 1_000_000_000_000_000 => value.checked_div(1_000),
        value if value >= 1_000_000_000_000 => Some(value),
        value if value >= 946_684_800 => value.checked_mul(1_000),
        _ => None,
    }
}

fn parse_live_started_at_string(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(epoch) = raw.parse::<i64>() {
        return normalize_epoch_millis(epoch);
    }
    if let Ok(datetime) = DateTime::parse_from_rfc3339(raw) {
        return Some(datetime.timestamp_millis());
    }

    // Bilibili 与斗鱼使用不带显式时区的挂钟时间字符串。
    // 它们的公开 API 将其定义为中国标准时间（UTC+08:00）。
    let china_standard_time = FixedOffset::east_opt(8 * 60 * 60)?;
    ["%Y-%m-%d %H:%M:%S%.f", "%Y/%m/%d %H:%M:%S%.f"]
        .iter()
        .find_map(|format| {
            NaiveDateTime::parse_from_str(raw, format)
                .ok()
                .and_then(|datetime| china_standard_time.from_local_datetime(&datetime).single())
                .map(|datetime| datetime.timestamp_millis())
        })
}

fn is_plausible_live_started_at(value: i64) -> bool {
    const EARLIEST_PLAUSIBLE_TIMESTAMP: i64 = 946_684_800_000; // 9 后端代理是否会抓取该主机。导出它便于测试断言弹幕片段校验器信任的每个 CDN 都可缓存。
    const FUTURE_GRACE_MILLIS: i64 = 5 * 60 * 1_000;
    value >= EARLIEST_PLAUSIBLE_TIMESTAMP
        && value
            <= Utc::now()
                .timestamp_millis()
                .saturating_add(FUTURE_GRACE_MILLIS)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum PlaybackProtocol {
    Flv,
    Hls,
    MpegTs,
    Native,
    #[default]
    Unknown,
}

impl PlaybackProtocol {
    /// 在上游响应未给出显式元数据时推断传输方式。
    /// 站点适配器应优先使用显式元数据。
    pub fn infer_from_url(url: &str) -> Self {
        let lower = url.to_ascii_lowercase();
        if lower.contains(".m3u8")
            || ["/hls/", "?hls=", "&hls=", "format=hls", "type=hls"]
                .iter()
                .any(|marker| lower.contains(marker))
        {
            Self::Hls
        } else if lower.contains(".flv")
            || ["format=flv", "type=flv"]
                .iter()
                .any(|marker| lower.contains(marker))
        {
            Self::Flv
        } else if lower.contains(".ts")
            || ["format=mpegts", "type=mpegts"]
                .iter()
                .any(|marker| lower.contains(marker))
        {
            Self::MpegTs
        } else if [".mp4", ".webm", ".m4v"]
            .iter()
            .any(|suffix| lower.contains(suffix))
        {
            Self::Native
        } else {
            Self::Unknown
        }
    }
}

/// 携带稳定且非机密路由信息的播放候选。
///
/// `source_id` 在同一份画质数据内保持稳定，且刻意不包含签名 URL。
/// `priority` 保留上游平台偏好的顺序；
/// 运行时代理探测可以在不改动此契约的前提下细化顺序。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TwitchAdRecovery {
    pub login: String,
    pub selector: String,
    #[serde(default)]
    pub target_width: u32,
    #[serde(default)]
    pub target_height: u32,
    #[serde(default)]
    pub target_frame_rate_milli: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayUrl {
    pub source_id: String,
    pub label: String,
    pub protocol: PlaybackProtocol,
    pub priority: u32,
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub twitch_ad_recovery: Option<TwitchAdRecovery>,
}

impl PlayUrl {
    pub fn inferred(
        source_id: impl Into<String>,
        label: impl Into<String>,
        priority: u32,
        url: String,
        headers: std::collections::HashMap<String, String>,
    ) -> Self {
        Self {
            source_id: source_id.into(),
            label: label.into(),
            protocol: PlaybackProtocol::infer_from_url(&url),
            priority,
            url,
            headers,
            twitch_ad_recovery: None,
        }
    }

    pub fn with_protocol(mut self, protocol: PlaybackProtocol) -> Self {
        self.protocol = protocol;
        self
    }

    pub fn with_twitch_ad_recovery(
        mut self,
        login: String,
        selector: String,
        target_width: u32,
        target_height: u32,
        target_frame_rate_milli: u32,
    ) -> Self {
        self.twitch_ad_recovery = Some(TwitchAdRecovery {
            login,
            selector,
            target_width,
            target_height,
            target_frame_rate_milli,
        });
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LivePlayQuality {
    pub quality: String,
    /// 后续 get_play_urls 所需的数据（因站点而异）；已知时就绪 URL 列表也放这里。
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomListPage {
    pub has_more: bool,
    pub items: Vec<LiveRoomItem>,
}

/// 房间号级去重守卫：空号、占位 `"0"` 和本页已出现过的房间都跳过。
///
/// 返回 `true` 表示这条应当收下。搜索会把同一个房间同时放进「在播」与
/// 「全部主播」两路索引，各站点合并两路结果时都要这一层判断。
pub fn accept_room_id(room_id: &str, seen: &mut std::collections::HashSet<String>) -> bool {
    !room_id.is_empty() && room_id != "0" && seen.insert(room_id.to_string())
}

impl RoomListPage {
    /// 没有结果的一页。空关键词、翻页越界等情况都用它，
    /// 避免各站点各写一遍同样的字面量。
    pub fn empty() -> Self {
        Self {
            has_more: false,
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuKind {
    Chat,
    Gift,
    Enter,
    /// Platform-generated social notices (e.g. “user followed the host”).
    ///
    /// 消费方可以像过滤服务进房通知一样过滤它们；独立的事件类型
    /// 让意图显式可见，
    /// 也为将来的可见性设置留出空间。
    Social,
    SuperChat,
    System,
}

/// Bilibili Super Chat 事件携带的可选元数据。
///
/// websocket 负载在不同 Bilibili 客户端间并非完全稳定，因此每个字段都独立可选。
/// 取值在解码进入本模型之前完成校验。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SuperChatInfo {
    /// Bilibili 的消息 id，客户端用它对重连做去重。
    pub id: Option<String>,
    /// Super Chat 的付费金额。
    pub price: Option<f64>,
    /// 上游负载提供时的 ISO 风格货币代码。
    pub currency: Option<String>,
    /// 安全的 CSS 十六进制主背景色。
    pub background_color: Option<String>,
    /// 安全的 CSS 十六进制次背景色（若提供）。
    pub background_bottom_color: Option<String>,
    /// 经校验的 Super Chat 发送者 Bilibili CDN 头像 URL。
    pub avatar_url: Option<String>,
    /// 高亮时长，单位为秒。
    pub duration: Option<u32>,
}

/// 经过校验的富文本弹幕消息有序片段。
///
/// 目前仅针对 Bilibili 图片表情发出。图片 URL 只有在强制 HTTPS 且主机属于
/// Bilibili 自有 CDN 之后才会被解码器接受，
/// 因此消费方可直接交给图片加载器，
/// 而不必把任意协议内容当作标记解析。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DanmakuContentSpan {
    Text { text: String },
    Image { image_url: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DanmakuEvent {
    pub kind: DanmakuKind,
    pub user: String,
    /// 该事件是否由本地保存 Cookie 中的账号发出。
    /// 这是 IPC 上唯一暴露的账号身份信号。
    #[serde(default)]
    pub is_self: bool,
    /// 协议层发送者 ID，仅供 Rust 侧账号匹配器使用。
    /// 它绝不能随弹幕事件离开后端。
    #[serde(skip)]
    pub user_id: Option<String>,
    pub content: String,
    pub color: Option<String>,
    /// 平台提供的富文本弹幕的可选文本/图片片段。
    #[serde(default)]
    pub spans: Option<Vec<DanmakuContentSpan>>,
    #[serde(default)]
    pub super_chat: Option<SuperChatInfo>,
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

    #[test]
    fn parses_platform_live_start_times_into_millis() {
        assert_eq!(
            parse_live_started_at(Some(&serde_json::json!(1_704_067_200))),
            Some(1_704_067_200_000)
        );
        assert_eq!(
            parse_live_started_at(Some(&serde_json::json!("2024-01-01 08:00:00"))),
            Some(1_704_067_200_000)
        );
        assert_eq!(
            parse_live_started_at(Some(&serde_json::json!("2024-01-01T00:00:00Z"))),
            Some(1_704_067_200_000)
        );
    }

    #[test]
    fn rejects_invalid_or_future_live_start_times() {
        assert_eq!(parse_live_started_at(Some(&serde_json::json!("bad"))), None);
        assert_eq!(parse_live_started_at(Some(&serde_json::json!(1234))), None);
        assert_eq!(
            parse_live_started_at(Some(&serde_json::json!(
                Utc::now().timestamp_millis() + 10 * 60 * 1_000
            ))),
            None
        );
    }
}
