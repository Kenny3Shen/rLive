//! Twitch 频道标识、房间详情与开播状态。

use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::models::live::{LiveRoomDetail, LiveRoomStatus, SiteId, parse_live_started_at};

use super::TwitchSite;
use super::parse::{first_non_empty, json_i64, json_string};

impl TwitchSite {
    pub(super) async fn room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let login = normalize_login(room_id)?;
        let data = self
            .graphql(
                "RLiveTwitchRoomStatus",
                r#"
                    query RLiveTwitchRoomStatus($login: String!) {
                      user(login: $login) {
                        stream {
                          createdAt
                        }
                      }
                    }
                "#,
                json!({ "login": login }),
            )
            .await?;
        parse_room_live_status(&data)
    }

    pub(super) async fn room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let login = normalize_login(room_id)?;
        let data = self
            .graphql(
                "RLiveTwitchRoom",
                r#"
                    query RLiveTwitchRoom($login: String!) {
                      user(login: $login) {
                        id
                        login
                        displayName
                        description
                        profileImageURL(width: 150)
                        stream {
                          id
                          createdAt
                          title
                          viewersCount
                          previewImageURL(width: 440, height: 248)
                          game {
                            id
                            displayName
                            name
                          }
                        }
                      }
                    }
                "#,
                json!({ "login": login }),
            )
            .await?;
        parse_room_detail(&data, &self.site_id, &login)
    }
}

pub(super) fn normalize_login(value: &str) -> AppResult<String> {
    let value = value.trim();
    let without_host = value
        .strip_prefix("https://www.twitch.tv/")
        .or_else(|| value.strip_prefix("http://www.twitch.tv/"))
        .or_else(|| value.strip_prefix("https://twitch.tv/"))
        .or_else(|| value.strip_prefix("http://twitch.tv/"))
        .unwrap_or(value);
    let login = without_host
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if login.is_empty()
        || login.len() > 25
        || !login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(
            AppError::new("twitch_invalid_room_id", "无效的 Twitch 频道名").with_site("twitch"),
        );
    }
    Ok(login)
}

fn parse_room_detail(
    data: &Value,
    site_id: &SiteId,
    fallback_login: &str,
) -> AppResult<LiveRoomDetail> {
    let user = data
        .get("user")
        .filter(|value| !value.is_null())
        .ok_or_else(|| {
            AppError::new("twitch_room_not_found", "未找到该 Twitch 频道").with_site("twitch")
        })?;
    let login = normalize_login(&first_non_empty([
        json_string(user.get("login")),
        fallback_login.to_string(),
    ]))?;
    let stream = user.get("stream").filter(|value| value.is_object());
    let status = stream.is_some();
    let title = stream
        .map(|stream| json_string(stream.get("title")))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| format!("{} 的直播间", json_string(user.get("displayName"))));
    let cover = stream
        .map(|stream| json_string(stream.get("previewImageURL")))
        .filter(|cover| !cover.is_empty())
        .unwrap_or_else(|| json_string(user.get("profileImageURL")));
    let stream_id = stream
        .map(|stream| json_string(stream.get("id")))
        .unwrap_or_default();
    Ok(LiveRoomDetail {
        site_id: site_id.clone(),
        room_id: login.clone(),
        title,
        cover,
        user_name: first_non_empty([json_string(user.get("displayName")), login.clone()]),
        user_avatar: json_string(user.get("profileImageURL")),
        online: stream
            .map(|stream| json_i64(stream.get("viewersCount")))
            .unwrap_or(0),
        status,
        live_started_at: stream.and_then(|stream| parse_live_started_at(stream.get("createdAt"))),
        notice: json_string(user.get("description")),
        url: format!("https://www.twitch.tv/{login}"),
        raw: json!({
            "login": login,
            "broadcaster_id": json_string(user.get("id")),
            "stream_id": stream_id,
        }),
    })
}

/// 关注刷新只向 Twitch 请求这份刻意收窄的 query：
/// 判断关注频道是否正在直播，
/// 不需要房间资料、预览图、标题或播放 token 数据。
fn parse_room_live_status(data: &Value) -> AppResult<LiveRoomStatus> {
    let user = data
        .get("user")
        .filter(|value| !value.is_null())
        .ok_or_else(|| {
            AppError::new("twitch_room_not_found", "未找到该 Twitch 频道").with_site("twitch")
        })?;
    let stream = user.get("stream").filter(|value| value.is_object());
    Ok(LiveRoomStatus {
        status: stream.is_some(),
        live_started_at: stream.and_then(|stream| parse_live_started_at(stream.get("createdAt"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_twitch_login_from_channel_url() {
        assert_eq!(
            normalize_login("https://www.twitch.tv/Caedrel/videos").unwrap(),
            "caedrel"
        );
        assert!(normalize_login("caedrel?oops").is_ok());
        assert!(normalize_login("not-a-valid-login").is_err());
    }

    #[test]
    fn parses_minimal_twitch_live_status() {
        let status = parse_room_live_status(&json!({
            "user": {
                "stream": {
                    "createdAt": "2024-07-03T09:46:40Z",
                    "playback_token_that_must_not_be_needed": "ignored"
                }
            }
        }))
        .expect("status");

        assert!(status.status);
        assert_eq!(status.live_started_at, Some(1_720_000_000_000));
    }

    #[test]
    fn parses_offline_twitch_live_status() {
        let status =
            parse_room_live_status(&json!({ "user": { "stream": null } })).expect("status");

        assert!(!status.status);
        assert_eq!(status.live_started_at, None);
    }
}
