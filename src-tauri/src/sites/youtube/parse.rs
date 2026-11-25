//! YouTube 网页和 Innertube 响应的防御性解析。

use std::collections::HashSet;

use reqwest::Url;
use serde_json::Value;

use crate::models::live::{LiveRoomItem, SiteId};

pub(super) fn visible_text(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    if let Some(text) = value.get("simpleText").and_then(Value::as_str) {
        return text.to_owned();
    }
    value
        .get("runs")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter_map(|run| run.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn best_thumbnail(value: Option<&Value>) -> String {
    value
        .and_then(|value| value.get("thumbnails"))
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().max_by_key(|item| {
                item.get("width")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
            })
        })
        .and_then(|item| item.get("url"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn avatar_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && (host == "yt3.ggpht.com"
            || host == "googleusercontent.com"
            || host.ends_with(".googleusercontent.com")))
    .then(|| url.to_string())
}

pub(super) fn parse_channel_avatar(value: &Value) -> String {
    let mut owners = Vec::new();
    walk(value, "videoOwnerRenderer", &mut owners);
    owners
        .into_iter()
        .find_map(|owner| avatar_url(&best_thumbnail(owner.get("thumbnail"))))
        .unwrap_or_default()
}

fn localised_count(text: &str) -> i64 {
    let compact = text
        .chars()
        .filter(|character| {
            character.is_ascii_digit() || matches!(character, '.' | ',' | '万' | '千' | '亿')
        })
        .collect::<String>();
    let (number, multiplier) = if let Some(value) = compact.strip_suffix('亿') {
        (value, 100_000_000.0)
    } else if let Some(value) = compact.strip_suffix('万') {
        (value, 10_000.0)
    } else if let Some(value) = compact.strip_suffix('千') {
        (value, 1_000.0)
    } else {
        (compact.as_str(), 1.0)
    };
    number
        .replace(',', "")
        .parse::<f64>()
        .ok()
        .map(|value| (value * multiplier).round().max(0.0) as i64)
        .unwrap_or_default()
}

fn walk(value: &Value, key: &str, output: &mut Vec<Value>) {
    match value {
        Value::Object(object) => {
            if let Some(found) = object.get(key) {
                output.push(found.clone());
            }
            for child in object.values() {
                walk(child, key, output);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, key, output);
            }
        }
        _ => {}
    }
}

fn walk_continuations(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(token) = value
                .pointer("/continuationEndpoint/continuationCommand/token")
                .and_then(Value::as_str)
                .or_else(|| {
                    value
                        .pointer("/continuationCommand/token")
                        .and_then(Value::as_str)
                })
            {
                output.push(token.to_owned());
            }
            for child in object.values() {
                walk_continuations(child, output);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk_continuations(item, output);
            }
        }
        _ => {}
    }
}

fn has_live_badge(renderer: &Value) -> bool {
    let mut badges = renderer
        .get("badges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|badge| badge.get("metadataBadgeRenderer"));
    if badges.any(|badge| {
        badge.get("style").and_then(Value::as_str) == Some("BADGE_STYLE_TYPE_LIVE_NOW")
            || badge.pointer("/icon/iconType").and_then(Value::as_str) == Some("LIVE")
    }) {
        return true;
    }
    renderer
        .get("thumbnailOverlays")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|overlay| overlay.get("thumbnailOverlayTimeStatusRenderer"))
        .any(|overlay| overlay.get("style").and_then(Value::as_str) == Some("LIVE"))
}

pub(super) fn parse_continuation(value: &Value) -> Option<String> {
    let mut tokens = Vec::new();
    walk_continuations(value, &mut tokens);
    tokens.pop()
}

pub(super) fn parse_room_items(value: &Value, site_id: &SiteId) -> Vec<LiveRoomItem> {
    let mut renderers = Vec::new();
    walk(value, "videoRenderer", &mut renderers);
    let mut seen = HashSet::new();
    renderers
        .into_iter()
        .filter_map(|renderer| {
            let room_id = renderer.get("videoId")?.as_str()?.to_owned();
            if room_id.len() != 11 || !seen.insert(room_id.clone()) {
                return None;
            }
            let title = visible_text(renderer.get("title"));
            let user_name = visible_text(
                renderer
                    .get("ownerText")
                    .or_else(|| renderer.get("longBylineText")),
            );
            let view_count = visible_text(
                renderer
                    .get("shortViewCountText")
                    .or_else(|| renderer.get("viewCountText")),
            );
            let live = has_live_badge(&renderer);
            Some(LiveRoomItem {
                site_id: site_id.clone(),
                room_id,
                title: if title.is_empty() {
                    format!("{user_name} 的 YouTube 直播")
                } else {
                    title
                },
                cover: best_thumbnail(renderer.get("thumbnail")),
                user_name,
                online: localised_count(&view_count),
                live_status: Some(live),
            })
        })
        .collect()
}

pub(super) fn best_thumbnail_from_video_details(value: &Value) -> String {
    best_thumbnail(value.get("thumbnail"))
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum HtmlVideoTarget {
    Video(String),
    NoLive,
    Unrecognized,
}

pub(super) fn html_video_target(html: &str) -> HtmlVideoTarget {
    let player = [
        "\"ytInitialPlayerResponse\":",
        "var ytInitialPlayerResponse =",
        "ytInitialPlayerResponse =",
    ]
    .into_iter()
    .find_map(|marker| json_object_after(html, marker))
    .and_then(|value| serde_json::from_str::<Value>(&value).ok())
    .and_then(|value| {
        value
            .pointer("/videoDetails/videoId")
            .and_then(Value::as_str)
            .and_then(|value| visible_video_id(value))
    });
    if let Some(video_id) = player {
        return HtmlVideoTarget::Video(video_id);
    }
    if let Some(canonical) = extract_quoted_after(html, "<link rel=\"canonical\" href=\"")
        .or_else(|| extract_quoted_after(html, "<link rel='canonical' href='"))
    {
        if let Ok(url) = Url::parse(&canonical)
            && matches!(
                url.host_str(),
                Some("youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com")
            )
        {
            let video_id = if url.path() == "/watch" {
                url.query_pairs().find_map(|(key, value)| {
                    (key == "v").then(|| visible_video_id(&value)).flatten()
                })
            } else {
                url.path_segments().and_then(|mut segments| {
                    (segments.next() == Some("live"))
                        .then(|| segments.next().and_then(visible_video_id))
                        .flatten()
                })
            };
            if let Some(video_id) = video_id {
                return HtmlVideoTarget::Video(video_id);
            }
        }
    }
    recognized_channel_page(html)
        .map(|recognized| {
            if recognized {
                HtmlVideoTarget::NoLive
            } else {
                HtmlVideoTarget::Unrecognized
            }
        })
        .unwrap_or(HtmlVideoTarget::Unrecognized)
}

fn recognized_channel_page(html: &str) -> Option<bool> {
    let marker = [
        "\"ytInitialData\":",
        "var ytInitialData =",
        "ytInitialData =",
    ]
    .into_iter()
    .find(|marker| html.contains(marker))?;
    let data = json_object_after(html, marker)
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())?;
    let mut metadata = Vec::new();
    walk(&data, "channelMetadataRenderer", &mut metadata);
    if !metadata.is_empty() {
        return Some(true);
    }
    let mut channel_ids = Vec::new();
    walk(&data, "channelId", &mut channel_ids);
    Some(channel_ids.into_iter().any(|value| {
        value.as_str().is_some_and(|channel_id| {
            channel_id.len() == 24
                && channel_id.starts_with("UC")
                && channel_id[2..]
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    }))
}

fn visible_video_id(value: &str) -> Option<String> {
    (value.len() == 11
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then(|| value.to_owned())
}

fn extract_quoted_after(html: &str, marker: &str) -> Option<String> {
    let rest = html.split_once(marker)?.1;
    let end = rest.find(|character| matches!(character, '"' | '\''))?;
    Some(rest[..end].to_owned())
}

fn json_object_after(html: &str, marker: &str) -> Option<String> {
    let tail = html.split_once(marker)?.1;
    let start = tail.find('{')?;
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for (offset, character) in tail[start..].char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
            continue;
        }
        match character {
            '"' => quoted = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let end = start + offset + character.len_utf8();
                    return Some(tail[start..end].to_owned());
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_live_cards_and_localised_viewers() {
        let data = json!({
            "contents": [{
                "videoRenderer": {
                    "videoId": "abcdefghijk",
                    "title": {"runs": [{"text": "测试直播"}]},
                    "ownerText": {"runs": [{"text": "频道"}]},
                    "thumbnail": {"thumbnails": [{"url": "small", "width": 1}, {"url": "large", "width": 720}]},
                    "shortViewCountText": {"runs": [{"text": "1.2万 人正在观看"}]},
                    "badges": [{"metadataBadgeRenderer": {
                        "style": "BADGE_STYLE_TYPE_LIVE_NOW"
                    }}]
                }
            }]
        });
        let items = parse_room_items(&data, &SiteId::Youtube);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].online, 12_000);
        assert_eq!(items[0].cover, "large");
        assert_eq!(items[0].live_status, Some(true));
    }

    #[test]
    fn vod_without_live_badge_is_not_marked_live() {
        let data = json!({"videoRenderer": {
            "videoId": "abcdefghijk",
            "title": {"simpleText": "LIVE replay but not live"}
        }});
        let items = parse_room_items(&data, &SiteId::Youtube);
        assert_eq!(items[0].live_status, Some(false));
    }

    #[test]
    fn extracts_only_channel_owner_avatar_from_next_response() {
        let data = json!({
            "videoPrimaryInfoRenderer": {
                "thumbnail": {"thumbnails": [{"url": "https://yt3.ggpht.com/video-evil=s720"}]}
            },
            "contents": {
                "videoOwnerRenderer": {
                    "thumbnail": {"thumbnails": [
                        {"url": "https://yt3.ggpht.com/channel=s48", "width": 48},
                        {"url": "https://yt3.ggpht.com/channel=s176", "width": 176}
                    ]}
                }
            }
        });
        assert_eq!(
            parse_channel_avatar(&data),
            "https://yt3.ggpht.com/channel=s176"
        );
    }

    #[test]
    fn rejects_non_youtube_avatar_hosts() {
        let data = json!({"videoOwnerRenderer": {"thumbnail": {"thumbnails": [
            {"url": "https://example.com/avatar.jpg", "width": 176}
        ]}}});
        assert!(parse_channel_avatar(&data).is_empty());
    }

    #[test]
    fn finds_continuation_inside_search_response() {
        let data = json!({"contents": [{"continuationItemRenderer": {
            "continuationEndpoint": {"continuationCommand": {"token": "next"}}
        }}]});
        assert_eq!(parse_continuation(&data).as_deref(), Some("next"));
    }

    #[test]
    fn extracts_video_id_without_taking_arbitrary_page_text() {
        let html = r#"<script>"recommended":{"videoId":"wrongwrong1"}</script>
            <script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abcdefghijk"}};</script>"#;
        assert_eq!(
            html_video_target(html),
            HtmlVideoTarget::Video("abcdefghijk".to_owned())
        );
    }

    #[test]
    fn recognizes_channel_page_without_current_live_video() {
        let html = r#"<script>var ytInitialData = {"metadata":{"channelMetadataRenderer":{
            "externalId":"UC1234567890123456789012"
        }}};</script>"#;
        assert_eq!(html_video_target(html), HtmlVideoTarget::NoLive);
    }

    #[test]
    fn rejects_unrecognized_channel_html_instead_of_assuming_offline() {
        assert_eq!(
            html_video_target("<html><body>maintenance</body></html>"),
            HtmlVideoTarget::Unrecognized
        );
        assert_eq!(
            html_video_target("<script>var ytInitialData = not-json;</script>"),
            HtmlVideoTarget::Unrecognized
        );
    }
}
