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
    /// Unix timestamp in milliseconds when the current live session started.
    /// Platforms do not all expose this value, so callers must handle `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_started_at: Option<i64>,
    pub notice: String,
    pub url: String,
    /// Opaque site-specific payload needed for play-url requests (JSON string ok).
    pub raw: serde_json::Value,
}

/// The small, refresh-safe subset of room metadata used by follow lists.
///
/// A follow refresh needs neither playback URLs nor danmaku connection data.
/// Keeping this as a separate model makes that boundary explicit in site
/// clients and prevents an innocuous status update from growing into a full
/// room-detail request again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveRoomStatus {
    pub status: bool,
    /// When a platform exposes it on its lightweight status endpoint, retain
    /// the live-session start time for the follow-list duration display.
    pub live_started_at: Option<i64>,
}

/// Convert the varied start-time representations used by live platforms into
/// a safe Unix timestamp in milliseconds.
///
/// Chinese platforms commonly send a China Standard Time string while other
/// services send an epoch timestamp or RFC3339 value. Values outside a
/// plausible live-service range are intentionally discarded instead of
/// displaying a misleading duration.
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
        // Nanoseconds, microseconds, milliseconds, then seconds.
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

    // Bilibili and Douyu use wall-clock strings without an explicit offset.
    // Their public APIs define these as China Standard Time (UTC+08:00).
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
    const EARLIEST_PLAUSIBLE_TIMESTAMP: i64 = 946_684_800_000; // 2000-01-01 UTC
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
    /// Infer a transport when the upstream response does not expose explicit
    /// metadata. Site adapters should prefer explicit metadata when available.
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

/// A playback candidate with stable, non-secret routing metadata.
///
/// `source_id` is stable within a quality payload and deliberately excludes
/// signed URLs. `priority` preserves the upstream platform's preferred order;
/// runtime proxy probes may refine that order without mutating this contract.
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
    /// Platform-generated social notices (e.g. “user followed the host”).
    ///
    /// Consumers filter these like service join notices; the distinct kind
    /// keeps the intent explicit and leaves room for a later visibility
    /// setting.
    Social,
    SuperChat,
    System,
}

/// Optional metadata carried by a Bilibili Super Chat event.
///
/// The websocket payload is not fully stable across Bilibili clients, so each
/// field is independently optional. Values are validated while decoding before
/// they enter this model.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SuperChatInfo {
    /// Bilibili's message id, used by clients to de-duplicate reconnects.
    pub id: Option<String>,
    /// Price paid for the Super Chat.
    pub price: Option<f64>,
    /// ISO-style currency code when supplied by the upstream payload.
    pub currency: Option<String>,
    /// Safe CSS hexadecimal primary background colour.
    pub background_color: Option<String>,
    /// Safe CSS hexadecimal secondary background colour, if supplied.
    pub background_bottom_color: Option<String>,
    /// Validated Bilibili CDN avatar URL for the Super Chat sender.
    pub avatar_url: Option<String>,
    /// Highlight duration in seconds.
    pub duration: Option<u32>,
}

/// A validated, ordered fragment of a rich danmaku message.
///
/// At present this is emitted only for Bilibili image emotes. Image URLs are
/// accepted by the decoder only after enforcing HTTPS and a Bilibili-owned CDN
/// host, so consumers can pass them to their image loader without interpreting
/// arbitrary protocol content as markup.
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
    /// True when this event was sent by the account in the locally saved Cookie.
    /// This is the only account-identity signal exposed over IPC.
    #[serde(default)]
    pub is_self: bool,
    /// Protocol-level sender ID used only by the Rust-side account matcher.
    /// It must never leave the backend with a danmaku event.
    #[serde(skip)]
    pub user_id: Option<String>,
    pub content: String,
    pub color: Option<String>,
    /// Optional text/image fragments for platform-provided rich danmaku.
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
