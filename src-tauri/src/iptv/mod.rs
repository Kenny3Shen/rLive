//! IPTV playlist loading and conservative M3U parsing.
//!
//! Playlist URLs are supplied by the user or by the public IPTV-org presets in
//! the UI.  We load them in Rust so remote playlists are not constrained by
//! WebView CORS, then return only display metadata and the stream URL.

use std::collections::HashMap;

use futures_util::StreamExt;
use reqwest::Url;
use serde::Serialize;

use crate::error::{AppError, AppResult};

const MAX_PLAYLIST_BYTES: usize = 8 * 1024 * 1024;
const MAX_CHANNELS: usize = 4_000;
const MAX_STREAM_HEADER_VALUE_BYTES: usize = 2_048;

#[derive(Debug, Clone, Serialize)]
pub struct IptvChannel {
    pub id: String,
    pub name: String,
    pub group: String,
    pub logo: Option<String>,
    pub url: String,
    /// The small allowlist of playback headers embedded in an M3U entry.
    /// These are forwarded by the localhost proxy to the stream and any HLS
    /// sub-resources, not persisted as account credentials.
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Default)]
struct PendingEntry {
    name: String,
    group: Option<String>,
    logo: Option<String>,
    headers: HashMap<String, String>,
}

/// Download a public or user-provided M3U playlist and return playable HTTP(S)
/// channel entries.  The source is intentionally capped to protect the desktop
/// process from malformed or unexpectedly huge lists.
pub async fn load_playlist(source_url: &str) -> AppResult<Vec<IptvChannel>> {
    let source = parse_http_url(source_url, "iptv_invalid_playlist_url")?;
    let response = crate::http_client::default_client()
        .get(source.clone())
        .send()
        .await
        .map_err(|_| {
            AppError::new("iptv_playlist_fetch", "无法获取频道列表，请检查地址和网络").retryable()
        })?;

    if !response.status().is_success() {
        return Err(AppError::new(
            "iptv_playlist_fetch",
            format!("频道列表服务返回 HTTP {}", response.status().as_u16()),
        )
        .retryable());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PLAYLIST_BYTES as u64)
    {
        return Err(AppError::new(
            "iptv_playlist_too_large",
            "频道列表超过 8 MB，无法安全加载",
        ));
    }

    let final_url = response.url().clone();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            AppError::new("iptv_playlist_fetch", "读取频道列表时连接中断").retryable()
        })?;
        if bytes.len().saturating_add(chunk.len()) > MAX_PLAYLIST_BYTES {
            return Err(AppError::new(
                "iptv_playlist_too_large",
                "频道列表超过 8 MB，无法安全加载",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    let playlist = String::from_utf8_lossy(&bytes);
    let channels = parse_m3u(&playlist, &final_url);
    if channels.is_empty() {
        return Err(AppError::new(
            "iptv_playlist_empty",
            "未在频道列表中找到可播放的 HTTP(S) 频道",
        ));
    }
    Ok(channels)
}

fn parse_http_url(value: &str, error_code: &str) -> AppResult<Url> {
    let url = Url::parse(value.trim())
        .map_err(|_| AppError::new(error_code, "请输入有效的 HTTP(S) 频道列表地址"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::new(
            error_code,
            "仅支持 HTTP(S) 频道列表和播放地址",
        ));
    }
    Ok(url)
}

fn parse_m3u(playlist: &str, base_url: &Url) -> Vec<IptvChannel> {
    let mut channels = Vec::new();
    let mut pending: Option<PendingEntry> = None;

    for raw_line in playlist.trim_start_matches('\u{feff}').lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(extinf) = line.strip_prefix("#EXTINF:") {
            pending = Some(parse_extinf(extinf));
            continue;
        }
        if let Some(group) = line.strip_prefix("#EXTGRP:") {
            if let Some(entry) = pending.as_mut() {
                let group = group.trim();
                if !group.is_empty() {
                    entry.group = Some(group.to_string());
                }
            }
            continue;
        }
        if let Some(option) = line.strip_prefix("#EXTVLCOPT:") {
            if let Some(entry) = pending.as_mut() {
                apply_vlc_option(entry, option);
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }

        let Some(entry) = pending.take() else {
            continue;
        };
        let Ok(stream_url) = base_url.join(line) else {
            continue;
        };
        if !matches!(stream_url.scheme(), "http" | "https") {
            continue;
        }
        // MPEG-DASH needs a separate player and manifest rewriter. Do not
        // expose a known DASH URL as a playable HLS/MSE entry.
        if stream_url.path().to_ascii_lowercase().ends_with(".mpd") {
            continue;
        }

        let name = if entry.name.trim().is_empty() {
            stream_url.host_str().unwrap_or("未命名频道").to_string()
        } else {
            entry.name
        };
        let group = entry
            .group
            .filter(|group| !group.trim().is_empty())
            .unwrap_or_else(|| "未分组".to_string());
        let logo = entry.logo.and_then(|logo| {
            parse_http_url(&logo, "iptv_invalid_logo_url")
                .ok()
                .map(|url| url.to_string())
        });

        channels.push(IptvChannel {
            id: channels.len().to_string(),
            name,
            group,
            logo,
            url: stream_url.to_string(),
            headers: entry.headers,
        });
        if channels.len() >= MAX_CHANNELS {
            break;
        }
    }

    channels
}

fn parse_extinf(value: &str) -> PendingEntry {
    let (attributes, name) = split_extinf_name(value);
    let mut headers = HashMap::new();
    for (attribute, header) in [
        ("http-user-agent", "user-agent"),
        ("http-referrer", "referer"),
        ("http-referer", "referer"),
    ] {
        if let Some(value) = attribute_value(attributes, attribute) {
            insert_stream_header(&mut headers, header, &value);
        }
    }
    PendingEntry {
        name: attribute_value(attributes, "tvg-name")
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| name.trim().to_string()),
        group: attribute_value(attributes, "group-title"),
        logo: attribute_value(attributes, "tvg-logo"),
        headers,
    }
}

fn apply_vlc_option(entry: &mut PendingEntry, option: &str) {
    let Some((name, value)) = option.split_once('=') else {
        return;
    };
    let header = match name.trim().to_ascii_lowercase().as_str() {
        "http-user-agent" => "user-agent",
        "http-referrer" | "http-referer" => "referer",
        _ => return,
    };
    insert_stream_header(&mut entry.headers, header, value);
}

fn insert_stream_header(headers: &mut HashMap<String, String>, name: &str, value: &str) {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_STREAM_HEADER_VALUE_BYTES
        || value.bytes().any(|byte| matches!(byte, b'\r' | b'\n' | 0))
    {
        return;
    }
    headers.insert(name.to_string(), value.to_string());
}

fn split_extinf_name(value: &str) -> (&str, &str) {
    let mut quoted = false;
    for (index, ch) in value.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        } else if ch == ',' && !quoted {
            return (&value[..index], &value[index + ch.len_utf8()..]);
        }
    }
    (value, "")
}

fn attribute_value(attributes: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    let start = attributes.find(&needle)? + needle.len();
    let value = &attributes[start..];
    if let Some(quoted) = value.strip_prefix('"') {
        return quoted.split_once('"').map(|(value, _)| value.to_string());
    }
    value
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use reqwest::Url;

    use super::parse_m3u;

    #[test]
    fn parses_display_fields_and_relative_stream_urls() {
        let playlist = r#"
#EXTM3U
#EXTINF:-1 tvg-name="新闻频道" tvg-logo="https://example.test/logo.png" group-title="新闻",示例新闻
live/news.m3u8
#EXTINF:-1 group-title="电影",示例电影
udp://239.0.0.1:1234
#EXTINF:-1,未分组频道
https://media.example.test/channel.m3u8
"#;
        let base = Url::parse("https://example.test/playlists/list.m3u").unwrap();
        let channels = parse_m3u(playlist, &base);

        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].name, "新闻频道");
        assert_eq!(channels[0].group, "新闻");
        assert_eq!(
            channels[0].url,
            "https://example.test/playlists/live/news.m3u8"
        );
        assert_eq!(channels[1].group, "未分组");
    }

    #[test]
    fn keeps_name_when_tvg_name_is_absent() {
        let base = Url::parse("https://example.test/list.m3u").unwrap();
        let channels = parse_m3u("#EXTINF:-1,公共频道\nhttps://example.test/live.m3u8", &base);
        assert_eq!(channels[0].name, "公共频道");
    }

    #[test]
    fn keeps_allowed_playback_headers_and_ignores_dash_entries() {
        let playlist = r#"
#EXTINF:-1 http-referrer="https://example.test/watch" http-user-agent="first agent",示例频道
#EXTVLCOPT:http-user-agent=updated agent
#EXTVLCOPT:http-referrer=https://example.test/embed
https://media.example.test/live.m3u8
#EXTINF:-1,Unsupported DASH
https://media.example.test/manifest.mpd
"#;
        let base = Url::parse("https://example.test/list.m3u").unwrap();
        let channels = parse_m3u(playlist, &base);

        assert_eq!(channels.len(), 1);
        assert_eq!(
            channels[0].headers.get("user-agent"),
            Some(&"updated agent".to_string())
        );
        assert_eq!(
            channels[0].headers.get("referer"),
            Some(&"https://example.test/embed".to_string())
        );
    }
}
