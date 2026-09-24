//! IPTV 播放列表加载与保守的 M3U 解析。
//!
//! 播放列表 URL 由用户提供，或来自 UI 内置的公开 IPTV-org 预设。在 Rust 中
//! 加载它们，使远程播放列表不受 WebView CORS 限制，
//! 随后只返回展示元数据与流地址。

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use futures_util::{StreamExt, stream};
use reqwest::{
    Client, Url,
    header::{ACCEPT, HeaderValue, REFERER, USER_AGENT},
};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::live::PlaybackProtocol;

const MAX_PLAYLIST_BYTES: usize = 8 * 1024 * 1024;
const MAX_CHANNELS: usize = 4_000;
const MAX_STREAM_HEADER_VALUE_BYTES: usize = 2_048;
const MAX_CHANNEL_CHECKS: usize = 32;
const CHANNEL_CHECK_CONCURRENCY: usize = 12;
const CHANNEL_CHECK_TIMEOUT: Duration = Duration::from_secs(7);
/// 深探测的单个媒体资源预算；比清单本身更短，避免拖长整批检测。
const CHANNEL_CHECK_MEDIA_TIMEOUT: Duration = Duration::from_secs(5);
const CHANNEL_CHECK_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CHANNEL_CHECK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct IptvChannel {
    pub id: String,
    pub name: String,
    pub group: String,
    pub logo: Option<String>,
    pub url: String,
    pub protocol: PlaybackProtocol,
    /// M3U 条目中内嵌的少量播放头字段白名单。
    /// 它们由本机代理转发给流及其 HLS 子资源，
    /// 不作为账号凭据持久化。
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IptvChannelCheck {
    pub url: String,
    pub headers: HashMap<String, String>,
    /// 是否在「网络可达」之外继续验证媒体：拉取清单引用的首个分片/子播放列表。
    ///
    /// 默认 false —— 深探测要额外字节与并发，只在用户主动要求时开启。
    /// 缺少该字段时按 false 处理，旧调用方行为不变。
    #[serde(default)]
    pub deep: bool,
}

/// 探测强度。分级的原因是「HTTP 200 + #EXTM3U」只说明清单本身可达，
/// 不代表它引用的媒体还能播（常见于分片 403、清单已轮换）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IptvProbeLevel {
    /// 上游给了可识别的媒体清单，但未验证其引用的媒体。
    Reachable,
    /// 已取到清单引用的首个媒体分片或子播放列表。
    MediaVerified,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IptvChannelAvailability {
    pub url: String,
    /// 是否至少网络可达。保留旧字段名，避免既有调用方同时改两处语义。
    pub available: bool,
    pub latency_ms: u64,
    pub http_status: Option<u16>,
    pub message: Option<String>,
    /// 本次实际达到的探测强度；失败时为 `None`。
    pub level: Option<IptvProbeLevel>,
    /// 深探测失败的原因（例如首个分片 403）。浅探测下恒为 `None`。
    pub media_message: Option<String>,
}

#[derive(Debug, Default)]
struct PendingEntry {
    name: String,
    group: Option<String>,
    logo: Option<String>,
    headers: HashMap<String, String>,
}

/// 下载公开或用户提供的 M3U 播放列表，返回可播放的 HTTP(S) 频道条目。
/// 来源大小刻意设置上限，
/// 保护桌面进程免受畸形或异常巨大的列表影响。
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

/// 在有界集合内检测流地址，不挂载播放器，也不占用应用级媒体代理。
/// 仅有成功的 HTTP 响应头并不足够：
/// 每个探测都会等待媒体字节并校验 HLS 清单。
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
    // 按**完整播放配置**去重，而不是只看 URL：同一 URL 配不同的 Referer/UA
    // 是 IPTV 列表里的常见写法（同一 CDN 路径在不同站点下返回 403 或 200），
    // 按 URL 去重会让第二个条目的结果被第一个冒名顶替。
    let mut seen = HashSet::new();
    let checks = checks
        .into_iter()
        .filter(|check| seen.insert(channel_check_identity(check)))
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
    for (name, value) in &check.headers {
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

    // 浅探测到此为止：清单本身可达。深探测再验证它引用的首个媒体资源。
    let (level, media_message) = if check.deep {
        match verify_first_media(client, &response_url, &payload, &check.headers).await {
            MediaCheck::Verified => (IptvProbeLevel::MediaVerified, None),
            // 清单里没有可验证的引用（只有注释、空行或非 HTTP 地址）：
            // 没有证据说它不可播，但也**没有**验证过媒体，因此留在「网络可达」。
            MediaCheck::NothingToVerify => (IptvProbeLevel::Reachable, None),
            MediaCheck::Failed(reason) => (IptvProbeLevel::Reachable, Some(reason)),
        }
    } else {
        (IptvProbeLevel::Reachable, None)
    };

    IptvChannelAvailability {
        url,
        available: true,
        latency_ms: elapsed_millis(started),
        http_status: Some(status.as_u16()),
        message: None,
        level: Some(level),
        media_message,
    }
}

/// 深探测对首个媒体资源的验证结论。
///
/// 必须把「验证成功」与「没有可验证的引用」分开：后者不是失败，但也**不是**
/// 验证过，把它当成 `Verified` 会让「清单里只有注释」显示成「媒体已验证」。
enum MediaCheck {
    Verified,
    NothingToVerify,
    Failed(String),
}

/// 取清单引用的首个媒体资源，确认它真的可读。
///
/// 只取**一个**子播放列表或分片，且只读首字节块：目的是把「清单可达」
/// 升级成「至少有一段媒体可读」，而不是完整下载频道内容。
/// 拿不到就返回人类可读的原因，调用方仍会把它标为「网络可达」而非失败。
async fn verify_first_media(
    client: &Client,
    manifest_url: &Url,
    payload: &[u8],
    headers: &HashMap<String, String>,
) -> MediaCheck {
    let text = String::from_utf8_lossy(payload);
    let Some(reference) = first_media_reference(&text) else {
        return MediaCheck::NothingToVerify;
    };
    let Ok(target) = manifest_url.join(reference.trim()) else {
        return MediaCheck::Failed("清单中的媒体地址无效".to_string());
    };
    if target.scheme() != "http" && target.scheme() != "https" {
        return MediaCheck::NothingToVerify;
    }

    let mut request = client
        .get(target)
        .timeout(CHANNEL_CHECK_MEDIA_TIMEOUT)
        .header(ACCEPT, "application/vnd.apple.mpegurl, video/*, */*;q=0.8");
    for (name, value) in headers {
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
            return MediaCheck::Failed(if error.is_timeout() {
                "首个媒体资源连接超时".to_string()
            } else {
                "首个媒体资源无法连接".to_string()
            });
        }
    };
    let status = response.status();
    if !status.is_success() {
        return MediaCheck::Failed(format!("首个媒体资源返回 HTTP {}", status.as_u16()));
    }
    // 只要首块字节可读即可；不解码、不缓存。
    let mut body = response.bytes_stream();
    match tokio::time::timeout(CHANNEL_CHECK_FIRST_BYTE_TIMEOUT, body.next()).await {
        Ok(Some(Ok(chunk))) if !chunk.is_empty() => MediaCheck::Verified,
        Ok(Some(Ok(_))) => MediaCheck::Failed("首个媒体资源未返回数据".to_string()),
        Ok(Some(Err(_))) => MediaCheck::Failed("读取首个媒体资源失败".to_string()),
        Ok(None) => MediaCheck::Failed("首个媒体资源未返回数据".to_string()),
        Err(_) => MediaCheck::Failed("等待首个媒体资源超时".to_string()),
    }
}

/// 从清单里取第一个非注释、非空行的引用。
///
/// 对 HLS 来说这通常是子播放列表（主清单）或分片（媒体清单）；
/// 两种都能证明「清单之后的链路」是可用的。
fn first_media_reference(manifest: &str) -> Option<&str> {
    manifest.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        Some(line)
    })
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
        level: None,
        media_message: None,
    }
}

/// 播放配置身份：URL + 白名单播放头。用于去重与前端结果索引。
///
/// 只包含实际会随请求发送的头（user-agent / referer），且大小写归一：
/// 其余字段既不影响请求，也不应影响身份。
pub fn channel_check_identity(check: &IptvChannelCheck) -> String {
    let mut headers: Vec<(String, String)> = check
        .headers
        .iter()
        .filter_map(|(name, value)| {
            let name = name.trim().to_ascii_lowercase();
            matches!(name.as_str(), "user-agent" | "referer")
                .then(|| (name, value.trim().to_string()))
        })
        .collect();
    headers.sort();
    let mut identity = check.url.trim().to_string();
    for (name, value) in headers {
        identity.push('\n');
        identity.push_str(&name);
        identity.push(':');
        identity.push_str(&value);
    }
    identity
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
        // MPEG-DASH 需要单独的播放器和清单改写器。
        // 不要把已知的 DASH 地址暴露为可播放的 HLS/MSE 条目。
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

        let stream_url = stream_url.to_string();
        channels.push(IptvChannel {
            id: channels.len().to_string(),
            name,
            group,
            logo,
            protocol: PlaybackProtocol::infer_from_url(&stream_url),
            url: stream_url,
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

    use super::{
        IptvChannelAvailability, IptvChannelCheck, IptvProbeLevel, channel_check_identity,
        first_media_reference, parse_m3u, probe_channel,
    };
    use crate::models::live::PlaybackProtocol;

    async fn probe_local_response(path: &str, response: &'static [u8]) -> IptvChannelAvailability {
        probe_local(path, response, false, None).await
    }

    /// 可控上游：按顺序依次应答 `responses`（每项一次请求）。
    /// 深探测会发起第二次请求，因此第二项就是「首个媒体资源」的应答。
    async fn probe_local(
        path: &str,
        manifest: &'static [u8],
        deep: bool,
        media: Option<&'static [u8]>,
    ) -> IptvChannelAvailability {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for response in [Some(manifest), media].into_iter().flatten() {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(response);
            }
        });
        let result = probe_channel(
            &crate::http_client::default_client(),
            IptvChannelCheck {
                url: format!("http://{address}/{path}"),
                headers: HashMap::new(),
                deep,
            },
        )
        .await;
        let _ = server.join();
        result
    }

    #[test]
    fn playback_identity_separates_same_url_with_different_headers() {
        let base = IptvChannelCheck {
            url: "https://cdn.example/live.m3u8".into(),
            headers: HashMap::new(),
            deep: false,
        };
        let mut with_referer = base.clone();
        with_referer
            .headers
            .insert("Referer".into(), "https://site-a.example".into());
        let mut other_referer = base.clone();
        other_referer
            .headers
            .insert("referer".into(), "https://site-b.example".into());

        // 同 URL 不同请求头必须被当作两个检测目标：一个可能 403，另一个 200。
        assert_ne!(
            channel_check_identity(&base),
            channel_check_identity(&with_referer)
        );
        assert_ne!(
            channel_check_identity(&with_referer),
            channel_check_identity(&other_referer)
        );
        // 大小写与顺序归一后必须稳定。
        let mut reordered = other_referer.clone();
        reordered.headers.insert("User-Agent".into(), "UA".into());
        let mut same = other_referer.clone();
        same.headers.insert("user-agent".into(), "UA".into());
        assert_eq!(
            channel_check_identity(&reordered),
            channel_check_identity(&same)
        );
        // 不参与请求的字段不影响身份。
        let mut ignored = with_referer.clone();
        ignored
            .headers
            .insert("X-Ignored".into(), "whatever".into());
        assert_eq!(
            channel_check_identity(&with_referer),
            channel_check_identity(&ignored)
        );
    }

    #[test]
    fn first_media_reference_skips_comments_and_blank_lines() {
        let manifest = "#EXTM3U\n#EXT-X-VERSION:3\n\n  segment-001.ts  \nsegment-002.ts\n";
        assert_eq!(first_media_reference(manifest), Some("segment-001.ts"));
        assert_eq!(first_media_reference("#EXTM3U\n#EXT-X-ENDLIST\n"), None);
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
        assert_eq!(channels[0].protocol, PlaybackProtocol::Hls);
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
        // 浅探测只能说「清单可达」，不能声称媒体已验证。
        assert_eq!(result.level, Some(IptvProbeLevel::Reachable));
        assert!(result.media_message.is_none());
    }

    #[tokio::test]
    async fn deep_probe_verifies_the_first_media_resource() {
        let result = probe_local(
            "live.m3u8",
            b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: 44\r\nConnection: close\r\n\r\n#EXTM3U\n#EXT-X-VERSION:3\nsegment-001.ts\n",
            true,
            Some(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 5\r\nConnection: close\r\n\r\nbytes"),
        )
        .await;

        assert!(result.available);
        assert_eq!(result.level, Some(IptvProbeLevel::MediaVerified));
        assert!(result.media_message.is_none());
    }

    #[tokio::test]
    async fn deep_probe_reports_reachable_when_the_first_segment_is_forbidden() {
        // 清单有效但分片 403：这正是「可用但播不了」的典型形态，
        // 不能显示为已验证可播。
        let result = probe_local(
            "live.m3u8",
            b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: 44\r\nConnection: close\r\n\r\n#EXTM3U\n#EXT-X-VERSION:3\nsegment-001.ts\n",
            true,
            Some(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
        )
        .await;

        assert!(result.available, "清单可达仍应算网络可达");
        assert_eq!(result.level, Some(IptvProbeLevel::Reachable));
        assert_eq!(
            result.media_message.as_deref(),
            Some("首个媒体资源返回 HTTP 403")
        );
    }

    #[tokio::test]
    async fn deep_probe_without_a_verifiable_reference_stays_reachable() {
        // 清单只有注释：没有可验证的引用，不因此判失败。
        let result = probe_local(
            "live.m3u8",
            b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: 21\r\nConnection: close\r\n\r\n#EXTM3U\n#EXT-X-VERSION:3\n",
            true,
            None,
        )
        .await;

        assert!(result.available);
        assert_eq!(result.level, Some(IptvProbeLevel::Reachable));
        assert!(result.media_message.is_none());
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
