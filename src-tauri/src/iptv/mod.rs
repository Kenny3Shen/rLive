//! IPTV playlist loading and conservative M3U parsing.
//!
//! Playlist URLs are supplied by the user or by the public IPTV-org presets in
//! the UI.  We load them in Rust so remote playlists are not constrained by
//! WebView CORS, then return only display metadata and the stream URL.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use futures_util::{StreamExt, stream};
use reqwest::{
    Client, Url,
    header::{ACCEPT, HeaderValue, REFERER, USER_AGENT},
};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const MAX_PLAYLIST_BYTES: usize = 8 * 1024 * 1024;
const MAX_CHANNELS: usize = 4_000;
const MAX_STREAM_HEADER_VALUE_BYTES: usize = 2_048;
const MAX_CHANNEL_CHECKS: usize = 32;
const CHANNEL_CHECK_CONCURRENCY: usize = 12;
const CHANNEL_CHECK_TIMEOUT: Duration = Duration::from_secs(7);
const CHANNEL_CHECK_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CHANNEL_CHECK_BYTES: usize = 64 * 1024;

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IptvChannelCheck {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IptvChannelAvailability {
    pub url: String,
    pub available: bool,
    pub latency_ms: u64,
    pub http_status: Option<u16>,
    pub message: Option<String>,
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
pub async fn load_playlist(source_url: &str, proxy: Option<&str>) -> AppResult<Vec<IptvChannel>> {
    let source = parse_http_url(source_url, "iptv_invalid_playlist_url")?;
    let response = crate::http_client::client_for_proxy(proxy)?
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

/// Check a bounded set of stream URLs without mounting a player or claiming the
/// application-global media proxy. Successful HTTP headers alone are not
/// enough: each probe waits for media bytes and validates HLS manifests.
pub async fn check_channels(
    checks: Vec<IptvChannelCheck>,
    proxy: Option<&str>,
) -> AppResult<Vec<IptvChannelAvailability>> {
    if checks.len() > MAX_CHANNEL_CHECKS {
        return Err(AppError::new(
            "iptv_check_too_many_channels",
            format!("每批最多检测 {MAX_CHANNEL_CHECKS} 个频道"),
        ));
    }

    let client = crate::http_client::client_for_proxy(proxy)?;
    let mut seen = HashSet::new();
    let checks = checks
        .into_iter()
        .filter(|check| seen.insert(check.url.clone()))
        .enumerate();
    let mut results = stream::iter(checks)
        .map(|(index, check)| {
            let client = client.clone();
            async move { (index, probe_channel(&client, check).await) }
        })
        .buffer_unordered(CHANNEL_CHECK_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    results.sort_unstable_by_key(|(index, _)| *index);
    Ok(results.into_iter().map(|(_, result)| result).collect())
}

async fn probe_channel(client: &Client, check: IptvChannelCheck) -> IptvChannelAvailability {
    let started = Instant::now();
    let url = check.url.trim().to_string();
    let parsed_url = match parse_http_url(&url, "iptv_invalid_channel_url") {
        Ok(url) => url,
        Err(_) => {
            return unavailable_check(url, started, None, "频道地址无效");
        }
    };

    let mut request = client
        .get(parsed_url)
        .timeout(CHANNEL_CHECK_TIMEOUT)
        .header(
            ACCEPT,
            "application/vnd.apple.mpegurl, application/x-mpegurl, video/*, */*;q=0.8",
        );
    for (name, value) in check.headers {
        let header_name = match name.trim().to_ascii_lowercase().as_str() {
            "user-agent" => USER_AGENT,
            "referer" => REFERER,
            _ => continue,
        };
        if let Ok(value) = HeaderValue::from_str(value.trim()) {
            request = request.header(header_name, value);
        }
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let message = if error.is_timeout() {
                "连接超时"
            } else if error.is_connect() {
                "无法连接频道"
            } else {
                "频道请求失败"
            };
            return unavailable_check(url, started, None, message);
        }
    };
    let status = response.status();
    if !status.is_success() {
        return unavailable_check(
            url,
            started,
            Some(status.as_u16()),
            &format!("频道返回 HTTP {}", status.as_u16()),
        );
    }

    let response_url = response.url().clone();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let expects_hls = looks_like_hls(&response_url, &content_type);
    let mut payload = Vec::new();
    let mut body = response.bytes_stream();
    while payload.len() < MAX_CHANNEL_CHECK_BYTES {
        let next = match tokio::time::timeout(CHANNEL_CHECK_FIRST_BYTE_TIMEOUT, body.next()).await {
            Ok(next) => next,
            Err(_) => {
                return unavailable_check(url, started, Some(status.as_u16()), "等待频道数据超时");
            }
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                return unavailable_check(url, started, Some(status.as_u16()), "读取频道数据失败");
            }
        };
        if chunk.is_empty() {
            continue;
        }
        let remaining = MAX_CHANNEL_CHECK_BYTES - payload.len();
        payload.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if !expects_hls || contains_extm3u(&payload) {
            break;
        }
    }

    if payload.is_empty() {
        return unavailable_check(url, started, Some(status.as_u16()), "频道未返回媒体数据");
    }
    if looks_like_html(&content_type, &payload) {
        return unavailable_check(
            url,
            started,
            Some(status.as_u16()),
            "频道返回了网页而非媒体流",
        );
    }
    if expects_hls && !contains_extm3u(&payload) {
        return unavailable_check(
            url,
            started,
            Some(status.as_u16()),
            "频道未返回有效的 HLS 清单",
        );
    }

    IptvChannelAvailability {
        url,
        available: true,
        latency_ms: elapsed_millis(started),
        http_status: Some(status.as_u16()),
        message: None,
    }
}

fn unavailable_check(
    url: String,
    started: Instant,
    http_status: Option<u16>,
    message: &str,
) -> IptvChannelAvailability {
    IptvChannelAvailability {
        url,
        available: false,
        latency_ms: elapsed_millis(started),
        http_status,
        message: Some(message.to_string()),
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn looks_like_hls(url: &Url, content_type: &str) -> bool {
    url.path().to_ascii_lowercase().ends_with(".m3u8")
        || content_type.contains("mpegurl")
        || content_type.contains("vnd.apple.mpegurl")
}

fn contains_extm3u(payload: &[u8]) -> bool {
    payload
        .windows(b"#EXTM3U".len())
        .any(|part| part == b"#EXTM3U")
}

fn looks_like_html(content_type: &str, payload: &[u8]) -> bool {
    if content_type.contains("text/html") {
        return true;
    }
    let prefix = String::from_utf8_lossy(&payload[..payload.len().min(256)]).to_ascii_lowercase();
    let prefix = prefix.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
    prefix.starts_with("<!doctype html") || prefix.starts_with("<html")
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
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use reqwest::Url;

    use super::{IptvChannelAvailability, IptvChannelCheck, parse_m3u, probe_channel};

    async fn probe_local_response(path: &str, response: &'static [u8]) -> IptvChannelAvailability {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            stream.write_all(response).unwrap();
        });
        let result = probe_channel(
            &crate::http_client::default_client(),
            IptvChannelCheck {
                url: format!("http://{address}/{path}"),
                headers: HashMap::new(),
            },
        )
        .await;
        server.join().unwrap();
        result
    }

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

    #[tokio::test]
    async fn availability_probe_requires_hls_manifest_bytes() {
        let result = probe_local_response(
            "live.m3u8",
            b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: 25\r\nConnection: close\r\n\r\n#EXTM3U\n#EXT-X-VERSION:3\n",
        )
        .await;

        assert!(result.available);
        assert_eq!(result.http_status, Some(200));
        assert!(result.message.is_none());
    }

    #[tokio::test]
    async fn availability_probe_rejects_successful_html_response() {
        let result = probe_local_response(
            "live.m3u8",
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 31\r\nConnection: close\r\n\r\n<!doctype html><title>Verify</title>",
        )
        .await;

        assert!(!result.available);
        assert_eq!(result.http_status, Some(200));
        assert_eq!(result.message.as_deref(), Some("频道返回了网页而非媒体流"));
    }
}
