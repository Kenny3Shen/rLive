//! YouTube 视频/频道目标规范化和房间详情。

use reqwest::Url;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::models::live::{LiveRoomDetail, LiveRoomStatus, SiteId, parse_live_started_at};

use super::YoutubeSite;
use super::parse::{HtmlVideoTarget, best_thumbnail_from_video_details, html_video_target};

const YOUTUBE_HOSTS: [&str; 4] = [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
];

enum Target {
    Video(String),
    Page(String),
}

fn video_id(value: &str) -> Option<String> {
    let value = value.trim();
    (value.len() == 11
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then(|| value.to_owned())
}

fn parse_target(input: &str) -> Option<Target> {
    if let Some(id) = video_id(input) {
        return Some(Target::Video(id));
    }
    let input = input.trim();
    if input.starts_with('/') {
        return page_target(&format!("https://www.youtube.com{input}"));
    }
    if input.starts_with('@')
        || input.starts_with("channel/")
        || input.starts_with("c/")
        || input.starts_with("user/")
    {
        return page_target(&format!("https://www.youtube.com/{input}"));
    }
    let with_scheme = if input.starts_with("http://") || input.starts_with("https://") {
        input.to_owned()
    } else if input.contains('/') || input.contains('.') {
        format!("https://{input}")
    } else {
        return None;
    };
    page_target(&with_scheme)
}

fn page_target(input: &str) -> Option<Target> {
    let url = Url::parse(input).ok()?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if matches!(host.as_str(), "youtu.be" | "www.youtu.be") {
        return video_id(url.path().trim_matches('/')).map(Target::Video);
    }
    if !YOUTUBE_HOSTS.contains(&host.as_str()) {
        return None;
    }
    if url.path() == "/watch" {
        return url
            .query_pairs()
            .find_map(|(key, value)| (key == "v").then(|| video_id(&value)).flatten())
            .map(Target::Video);
    }
    let segments = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if matches!(segments.first().copied(), Some("live" | "embed" | "shorts")) {
        return segments
            .get(1)
            .and_then(|value| video_id(value))
            .map(Target::Video);
    }
    let first = *segments.first()?;
    let channel_path = if matches!(first, "@") || first.starts_with('@') {
        Some(format!("https://www.youtube.com/{first}/live"))
    } else if matches!(first, "channel" | "c" | "user") {
        let name = *segments.get(1)?;
        let valid = name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
        valid.then(|| format!("https://www.youtube.com/{first}/{name}/live"))
    } else {
        None
    };
    channel_path.map(Target::Page)
}

/// 返回可直接进入播放流程的 11 位视频 ID；频道主页应先由后端解析出直播视频。
pub(super) fn canonical_room_id(input: &str) -> Option<String> {
    match parse_target(input)? {
        Target::Video(id) => Some(id),
        Target::Page(_) => None,
    }
}

/// 返回规范化的 YouTube 视频或频道直播页，不保留任意跟踪参数。
pub(super) fn canonical_url(input: &str) -> Option<String> {
    match parse_target(input)? {
        Target::Video(id) => Some(format!("https://www.youtube.com/watch?v={id}")),
        Target::Page(url) => Some(url),
    }
}

impl YoutubeSite {
    async fn resolve_player(&self, input: &str) -> AppResult<Option<(String, Value)>> {
        match parse_target(input) {
            Some(Target::Video(id)) => {
                let player = self.player(&id).await?;
                player_is_live(&player, false)?;
                Ok(Some((id, player)))
            }
            Some(Target::Page(url)) => {
                let html = self.get_text(&url).await?;
                match html_video_target(&html) {
                    HtmlVideoTarget::Video(video_id) => {
                        let player = self.player(&video_id).await?;
                        Ok(player_is_live(&player, true)?.then_some((video_id, player)))
                    }
                    HtmlVideoTarget::NoLive => Ok(None),
                    HtmlVideoTarget::Unrecognized => Err(YoutubeSite::parse_err(
                        "YouTube 频道页结构无法识别，接口格式可能已变化",
                    )),
                }
            }
            None => Err(AppError::new(
                "youtube_invalid_room_id",
                "请输入 YouTube 直播视频 ID、视频链接或频道直播页",
            )
            .with_site("youtube")),
        }
    }

    fn metadata(
        &self,
        player: &Value,
        video_id: &str,
        status: bool,
        user_avatar: String,
    ) -> AppResult<LiveRoomDetail> {
        let details = player
            .get("videoDetails")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                YoutubeSite::err("youtube_video_unavailable", "该 YouTube 视频当前不可用")
            })?;
        let video_id = details
            .get("videoId")
            .and_then(Value::as_str)
            .and_then(|value| canonical_room_id(value))
            .unwrap_or_else(|| video_id.to_owned());
        let channel_id = details
            .get("channelId")
            .and_then(Value::as_str)
            .filter(|value| {
                value.len() == 24
                    && value.starts_with("UC")
                    && value[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            });
        let room_id = channel_id
            .map(|channel| format!("channel/{channel}"))
            .unwrap_or_else(|| video_id.clone());
        let author = details
            .get("author")
            .and_then(Value::as_str)
            .unwrap_or("YouTube");
        let title = details
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(author);
        Ok(LiveRoomDetail {
            site_id: SiteId::Youtube,
            room_id,
            title: title.to_owned(),
            cover: best_thumbnail_from_video_details(details),
            user_name: author.to_owned(),
            user_avatar,
            // player 的 viewCount 是累计播放次数，不是同时在线人数。
            // 搜索列表提供明确的 watching 文案；房间接口缺少可靠字段时保持未知。
            online: 0,
            status,
            live_started_at: player_live_started_at(player),
            notice: details
                .get("shortDescription")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            url: format!("https://www.youtube.com/watch?v={video_id}"),
            raw: serde_json::json!({
                "video_id": video_id,
                "channel_id": channel_id.unwrap_or_default(),
            }),
        })
    }

    pub(super) async fn room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let (video_id, player) = self.resolve_player(room_id).await?.ok_or_else(|| {
            AppError::new("youtube_not_live", "该 YouTube 频道当前没有公开直播")
                .with_site("youtube")
        })?;
        let status = player_is_live(&player, false)?;
        let user_avatar = self
            .channel_avatar(&video_id)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(
                    site = "youtube",
                    error = %error,
                    "YouTube channel avatar unavailable"
                );
                String::new()
            });
        self.metadata(&player, &video_id, status, user_avatar)
    }

    pub(super) async fn room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let Some((_video_id, player)) = self.resolve_player(room_id).await? else {
            return Ok(LiveRoomStatus {
                status: false,
                live_started_at: None,
            });
        };
        Ok(LiveRoomStatus {
            status: player_is_live(&player, false)?,
            live_started_at: player_live_started_at(&player),
        })
    }
}

fn player_live_started_at(player: &Value) -> Option<i64> {
    parse_live_started_at(
        player
            .pointer("/microformat/playerMicroformatRenderer/liveBroadcastDetails/startTimestamp"),
    )
}

pub(super) fn player_is_live(player: &Value, from_channel: bool) -> AppResult<bool> {
    let status = player
        .pointer("/playabilityStatus/status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reason = player
        .pointer("/playabilityStatus/reason")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(error) = playback_refusal(status, reason) {
        return Err(error);
    }
    if status == "LIVE_STREAM_OFFLINE" {
        return Ok(false);
    }
    let is_live = player
        .pointer("/videoDetails/isLive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if status == "OK" {
        return Ok(is_live);
    }
    if is_live {
        return Err(YoutubeSite::err(
            "youtube_playback_unavailable",
            "YouTube 直播暂时无法播放，请稍后重试",
        )
        .retryable());
    }
    if from_channel && status != "LIVE_STREAM_OFFLINE" {
        return Err(YoutubeSite::err(
            "youtube_channel_unavailable",
            "YouTube 频道播放信息暂时不可用，请稍后重试",
        )
        .retryable());
    }
    Ok(false)
}

fn playback_refusal(status: &str, reason: &str) -> Option<AppError> {
    let reason = reason.to_ascii_lowercase();
    if reason.contains("not a bot") || reason.contains("bot check") {
        Some(
            YoutubeSite::err(
                "youtube_bot_check",
                "YouTube 要求确认不是机器人，请更换代理节点或稍后重试",
            )
            .retryable(),
        )
    } else if reason.contains("age") {
        Some(YoutubeSite::err(
            "youtube_age_restricted",
            "该 YouTube 直播有年龄限制，当前匿名会话无法观看",
        ))
    } else if reason.contains("members") {
        Some(YoutubeSite::err(
            "youtube_members_only",
            "该 YouTube 直播仅限频道会员观看",
        ))
    } else if reason.contains("country") || reason.contains("region") || reason.contains("location")
    {
        Some(YoutubeSite::err(
            "youtube_geo_restricted",
            "该 YouTube 直播在当前网络所在地区不可观看",
        ))
    } else if reason.contains("private") {
        Some(YoutubeSite::err("youtube_private", "该 YouTube 直播未公开"))
    } else if status == "LOGIN_REQUIRED" {
        Some(YoutubeSite::err(
            "youtube_login_required",
            "YouTube 要求登录后才能观看该直播",
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalises_supported_video_urls() {
        for input in [
            "abcdefghijk",
            "https://youtu.be/abcdefghijk?t=8",
            "youtube.com/watch?v=abcdefghijk&feature=share",
            "https://www.youtube.com/live/abcdefghijk",
        ] {
            assert_eq!(canonical_room_id(input).as_deref(), Some("abcdefghijk"));
        }
    }

    #[test]
    fn canonicalises_channel_live_pages() {
        assert_eq!(
            canonical_url("https://www.youtube.com/@Example"),
            Some("https://www.youtube.com/@Example/live".to_owned())
        );
        assert_eq!(
            canonical_url("channel/UC1234567890123456789012"),
            Some("https://www.youtube.com/channel/UC1234567890123456789012/live".to_owned())
        );
        assert_eq!(
            canonical_url("/@Example"),
            Some("https://www.youtube.com/@Example/live".to_owned())
        );
    }

    #[test]
    fn rejects_non_youtube_hosts() {
        assert!(canonical_url("https://youtube.com.evil.test/watch?v=abcdefghijk").is_none());
    }

    #[test]
    fn distinguishes_live_ended_login_and_bot_states() {
        let live = serde_json::json!({
            "playabilityStatus": {"status": "OK"},
            "videoDetails": {"isLive": true}
        });
        assert!(player_is_live(&live, true).unwrap());

        let ended = serde_json::json!({
            "playabilityStatus": {"status": "LIVE_STREAM_OFFLINE"},
            "videoDetails": {"isLive": false}
        });
        assert!(!player_is_live(&ended, true).unwrap());

        let ended_but_flagged_live = serde_json::json!({
            "playabilityStatus": {"status": "LIVE_STREAM_OFFLINE"},
            "videoDetails": {"isLive": true}
        });
        assert!(!player_is_live(&ended_but_flagged_live, true).unwrap());

        let login = serde_json::json!({
            "playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "Sign in required"},
            "videoDetails": {"isLive": true}
        });
        assert_eq!(
            player_is_live(&login, true).unwrap_err().code,
            "youtube_login_required"
        );

        let bot = serde_json::json!({
            "playabilityStatus": {
                "status": "LOGIN_REQUIRED",
                "reason": "Sign in to confirm you're not a bot"
            },
            "videoDetails": {"isLive": true}
        });
        assert_eq!(
            player_is_live(&bot, true).unwrap_err().code,
            "youtube_bot_check"
        );
    }

    #[test]
    fn channel_playability_error_is_not_reported_as_offline() {
        let player = serde_json::json!({
            "playabilityStatus": {"status": "ERROR", "reason": "Video unavailable"},
            "videoDetails": {"isLive": false}
        });
        assert_eq!(
            player_is_live(&player, true).unwrap_err().code,
            "youtube_channel_unavailable"
        );
    }

    #[test]
    fn detail_keeps_stable_channel_and_current_video_with_start_time() {
        let site = YoutubeSite::new(reqwest::Client::new(), crate::proxy::ProxyRoute::Direct);
        let player = serde_json::json!({
            "playabilityStatus": {"status": "OK"},
            "microformat": {"playerMicroformatRenderer": {"liveBroadcastDetails": {
                "startTimestamp": "2024-07-03T09:46:40Z"
            }}},
            "videoDetails": {
                "videoId": "abcdefghijk",
                "channelId": "UC1234567890123456789012",
                "isLive": true,
                "title": "直播标题",
                "author": "频道",
                "viewCount": "2245000",
                "shortDescription": "简介"
            }
        });
        let detail = site
            .metadata(
                &player,
                "abcdefghijk",
                true,
                "https://yt3.ggpht.com/avatar=s176".to_owned(),
            )
            .expect("detail");
        assert_eq!(detail.room_id, "channel/UC1234567890123456789012");
        assert_eq!(detail.raw["video_id"], "abcdefghijk");
        assert_eq!(detail.online, 0);
        assert_eq!(detail.live_started_at, Some(1_720_000_000_000));
        assert_eq!(detail.user_avatar, "https://yt3.ggpht.com/avatar=s176");
    }
}
