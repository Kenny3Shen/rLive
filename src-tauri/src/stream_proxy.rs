//! 本机 HTTP 代理，为 WebView 媒体播放注入 CDN 所需请求头。
//!
//! 浏览器 `<video>` / MSE 无法为媒体请求附加 Bilibili 的 `Referer` /
//! `User-Agent`。该代理绑定 `127.0.0.1:0`，携带所需请求头转发直播地址，
//! 并为 xgplayer 协议插件返回一个同源友好的流地址 —— 无需 mpv HWND。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio::task::JoinSet;

use crate::error::{AppError, AppResult};
use crate::models::live::{PlayUrl, PlaybackProtocol, TwitchAdRecovery};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROBE_SOURCES: usize = 12;
const MAX_PROBE_SAMPLE_BYTES: usize = 64 * 1024;
// FFmpeg 给每次本机读取 10 秒。要在解复用器把本地代理视为无响应之前，
// 留出足够时间交付一份 gap 播放列表。
const TWITCH_MANIFEST_RECOVERY_BUDGET: Duration = Duration::from_secs(4);
/// 录制等待 Twitch 清单代理产出带真实分片的播放列表的最长时间。
/// 最慢的情况是广告插播叠加对兜底播放 profile 的完整轮询；
/// 超过此时限后，录制会报告无法启动的原因，
/// 而不是把一份只有占位符、永远打不开的播放列表交给 libavformat。
///
/// 录制仅限桌面端，因此这里与下方的预热路径都遵循与 `recording` 模块相同的
/// 闸门，避免在 Android 上成为死代码。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub const TWITCH_RECORDING_WARMUP_BUDGET: Duration = Duration::from_secs(20);
/// Twitch 的媒体清单声明约 2 秒一个分片，
/// 比这更快地重复轮询不会带来尚不存在的媒体。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
const TWITCH_RECORDING_WARMUP_INTERVAL: Duration = Duration::from_millis(1_000);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StreamProxyProbe {
    pub source_id: String,
    pub index: usize,
    pub available: bool,
    pub status: Option<u16>,
    pub ttfb_ms: Option<u64>,
    pub content_type: Option<String>,
    pub sampled_bytes: u64,
    pub error_code: Option<String>,
}

/// 经由真实中继所用的同一上游代理探测播放候选。结果按输入顺序返回，
/// 且不包含 URL、Cookie、Referer、重定向目标或传输错误文本。
pub async fn probe_sources(
    sources: Vec<PlayUrl>,
    proxy: Option<&str>,
) -> AppResult<Vec<StreamProxyProbe>> {
    let client = build_probe_client(proxy)?;
    let probes =
        futures_util::stream::iter(sources.into_iter().take(MAX_PROBE_SOURCES).enumerate().map(
            |(index, source)| {
                let client = client.clone();
                async move { (index, probe_source(&client, index, source).await) }
            },
        ))
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    let mut probes = probes;
    probes.sort_by_key(|(index, _)| *index);
    Ok(probes.into_iter().map(|(_, probe)| probe).collect())
}

async fn probe_source(client: &Client, index: usize, source: PlayUrl) -> StreamProxyProbe {
    let mut result = StreamProxyProbe {
        source_id: source.source_id.clone(),
        index,
        available: false,
        status: None,
        ttfb_ms: None,
        content_type: None,
        sampled_bytes: 0,
        error_code: None,
    };
    let started = Instant::now();
    let request = async {
        let mut request = client.get(&source.url);
        for (name, value) in &source.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        request = request.header(reqwest::header::ACCEPT_ENCODING, "identity");
        let response = request.send().await.map_err(|_| "network")?;
        result.status = Some(response.status().as_u16());
        result.content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or(value)
                    .trim()
                    .to_ascii_lowercase()
            })
            .filter(|value| !value.is_empty());
        if !response.status().is_success() {
            return Err("http_status");
        }

        let mut body = response.bytes_stream();
        let Some(chunk) = body.next().await else {
            return Err("empty_body");
        };
        let chunk = chunk.map_err(|_| "network")?;
        let sample = &chunk[..chunk.len().min(MAX_PROBE_SAMPLE_BYTES)];
        result.sampled_bytes = sample.len() as u64;
        result.ttfb_ms = Some(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
        validate_probe_sample(source.protocol, result.content_type.as_deref(), sample)
    };

    match tokio::time::timeout(PROBE_TIMEOUT, request).await {
        Ok(Ok(())) => result.available = true,
        Ok(Err(code)) => result.error_code = Some(code.to_string()),
        Err(_) => result.error_code = Some("timeout".into()),
    }
    result
}

fn validate_probe_sample(
    protocol: PlaybackProtocol,
    content_type: Option<&str>,
    sample: &[u8],
) -> Result<(), &'static str> {
    if sample.is_empty() {
        return Err("empty_body");
    }
    if content_type.is_some_and(|value| value.contains("text/html"))
        || sample
            .iter()
            .copied()
            .skip_while(u8::is_ascii_whitespace)
            .take(16)
            .collect::<Vec<_>>()
            .starts_with(b"<!DOCTYPE")
    {
        return Err("html_response");
    }
    match protocol {
        PlaybackProtocol::Hls if !looks_like_hls_manifest(sample) => Err("invalid_hls"),
        PlaybackProtocol::Flv if !sample.starts_with(b"FLV") => Err("invalid_flv"),
        PlaybackProtocol::MpegTs if sample.first() != Some(&0x47) => Err("invalid_mpeg_ts"),
        _ => Ok(()),
    }
}

/// 按前端播放会话索引的活动代理端点。
///
/// 每个播放器拥有独立的回环监听器。更换画质或线路只替换该播放器
/// `session_id` 对应的监听器；
/// 其他播放器继续推流，不共享生命周期状态。
pub struct StreamProxy {
    state: Mutex<ProxyState>,
}

/// 所有生命周期变更共用一段简短的同步临界区。
///
/// 绑定 TCP 监听器是异步的，因此仅有活动代理不足以描述生命周期：
/// 在创建新监听器的过程中，还需要记住允许哪个播放会话安装它。
/// 否则两个重叠的 `start` 命令可能各自绑定监听器，
/// 而后到的赋值会让先前的任务变成孤儿。
#[derive(Default)]
struct ProxyState {
    active: HashMap<String, ProxyInner>,
    pending: HashMap<String, u64>,
    generation: u64,
}

struct ProxyInner {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
    telemetry: Arc<ProxyTelemetryCounters>,
}

#[derive(Debug)]
struct ProxyTelemetryCounters {
    started_at_ms: u64,
    upstream_requests: AtomicU64,
    upstream_failures: AtomicU64,
    bytes_forwarded: AtomicU64,
    first_response_ms: AtomicU64,
    latest_response_ms: AtomicU64,
    /// 本会话第一个被转发的媒体字节的挂钟纪元。
    ///
    /// 多视图时钟对齐需要绝对锚点，用于容器本身不带挂钟的流
    /// （FLV/MPEG-TS 时间戳从接近零开始）。把这个纪元与播放器启动时观察到的
    /// 媒体时间轴位置配对，即可把 `currentTime` 转换为估计的采集时刻。
    /// CDN 自身的边缘突发也包含在估计里，
    /// 因此它只在多条流之间可比，绝不是精确的采集瞬间。
    first_media_at_ms: AtomicU64,
}

impl ProxyTelemetryCounters {
    fn new() -> Self {
        Self {
            started_at_ms: unix_timestamp_ms(),
            upstream_requests: AtomicU64::new(0),
            upstream_failures: AtomicU64::new(0),
            bytes_forwarded: AtomicU64::new(0),
            first_response_ms: AtomicU64::new(0),
            latest_response_ms: AtomicU64::new(0),
            first_media_at_ms: AtomicU64::new(0),
        }
    }

    /// 锁存第一个媒体字节的纪元；后续分片沿用第一个的取值。
    fn record_media_start(&self) {
        let _ = self.first_media_at_ms.compare_exchange(
            0,
            unix_timestamp_ms().max(1),
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
    }

    fn record_response(&self, elapsed: Duration) {
        let millis = elapsed.as_millis().min(u64::MAX as u128) as u64;
        self.latest_response_ms
            .store(millis.max(1), Ordering::Relaxed);
        let _ = self.first_response_ms.compare_exchange(
            0,
            millis.max(1),
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
    }

    fn record_bytes(&self, bytes: usize) {
        self.bytes_forwarded
            .fetch_add(bytes.min(u64::MAX as usize) as u64, Ordering::Relaxed);
    }

    fn snapshot(&self) -> StreamProxyTelemetry {
        let optional = |value| (value > 0).then_some(value);
        StreamProxyTelemetry {
            started_at_ms: self.started_at_ms,
            upstream_requests: self.upstream_requests.load(Ordering::Relaxed),
            upstream_failures: self.upstream_failures.load(Ordering::Relaxed),
            bytes_forwarded: self.bytes_forwarded.load(Ordering::Relaxed),
            first_response_ms: optional(self.first_response_ms.load(Ordering::Relaxed)),
            latest_response_ms: optional(self.latest_response_ms.load(Ordering::Relaxed)),
            first_media_at_ms: optional(self.first_media_at_ms.load(Ordering::Relaxed)),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StreamProxyTelemetry {
    pub started_at_ms: u64,
    pub upstream_requests: u64,
    pub upstream_failures: u64,
    pub bytes_forwarded: u64,
    pub first_response_ms: Option<u64>,
    pub latest_response_ms: Option<u64>,
    pub first_media_at_ms: Option<u64>,
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

/// 代理把 HLS 清单改写到这个本机监听器上。只有清单中出现的 URL 才会被
/// 登记进注册表，因此回环服务器不会沦为
/// 浏览器可任意访问的通用请求代理。
struct HlsResources {
    next_id: AtomicU64,
    max_entries: usize,
    entries: Mutex<HlsResourceEntries>,
}

struct HlsResourceEntries {
    by_id: HashMap<u64, String>,
    by_url: HashMap<String, u64>,
    /// 最近最少使用的资源标识符排在最前。选中的 HLS 子播放列表在每次刷新时都会
    /// 被请求，而单个媒体分片通常只请求一次。把它当作访问队列处理，
    /// 可以让那条长期存活的播放列表映射不被淘汰。
    access_order: VecDeque<u64>,
}

struct TwitchAdRecoverySession {
    config: TwitchAdRecovery,
    client: Client,
    state: AsyncMutex<TwitchAdRecoveryState>,
    recovery_in_flight: AtomicBool,
}

struct TwitchAdRecoveryState {
    /// `TWITCH_AD_FALLBACK_PROFILES` 中每个条目各对应一条缓存的兜底播放列表 URL，
    /// 按数组位置索引。
    fallback_urls: [Option<String>; crate::sites::twitch::TWITCH_AD_FALLBACK_PROFILES.len()],
    active_profile: Option<usize>,
    last_clean_manifest: Option<(String, Url)>,
    current_manifest_url: Option<String>,
    revision: u64,
}

#[derive(Clone)]
struct TwitchAdRecoverySnapshot {
    fallback_urls: [Option<String>; crate::sites::twitch::TWITCH_AD_FALLBACK_PROFILES.len()],
    active_profile: Option<usize>,
    revision: u64,
}

struct TwitchAdRecoveryAttempt {
    fallback_urls: [Option<String>; crate::sites::twitch::TWITCH_AD_FALLBACK_PROFILES.len()],
    replacement: Option<(usize, TwitchManifestReplacement)>,
}

struct TwitchRecoveryLease<'a> {
    in_flight: &'a AtomicBool,
}

impl Drop for TwitchRecoveryLease<'_> {
    fn drop(&mut self) {
        self.in_flight.store(false, Ordering::Release);
    }
}

struct TwitchManifestReplacement {
    body: String,
    upstream_url: Url,
}

#[derive(Clone)]
struct ProxyLoopContext {
    client: Client,
    url: Arc<str>,
    headers: Arc<HashMap<String, String>>,
    hls_resources: Arc<HlsResources>,
    local_origin: Arc<str>,
    force_hls: bool,
    twitch_ad_recovery: Option<Arc<TwitchAdRecoverySession>>,
    telemetry: Arc<ProxyTelemetryCounters>,
}

impl TwitchAdRecoverySession {
    fn new(config: TwitchAdRecovery, client: Client) -> Self {
        Self {
            config,
            client,
            state: AsyncMutex::new(TwitchAdRecoveryState {
                fallback_urls: [const { None };
                    crate::sites::twitch::TWITCH_AD_FALLBACK_PROFILES.len()],
                active_profile: None,
                last_clean_manifest: None,
                current_manifest_url: None,
                revision: 0,
            }),
            recovery_in_flight: AtomicBool::new(false),
        }
    }

    async fn replace_ad_manifest(
        &self,
        manifest: &str,
        upstream_url: &Url,
        headers: &HashMap<String, String>,
    ) -> Option<TwitchManifestReplacement> {
        if !is_twitch_ad_manifest(manifest) {
            let mut state = self.state.lock().await;
            state.active_profile = None;
            if looks_like_hls_manifest(manifest.as_bytes()) {
                state.last_clean_manifest = Some((manifest.to_string(), upstream_url.clone()));
                state.current_manifest_url = Some(upstream_url.to_string());
                state.revision = state.revision.wrapping_add(1);
            }
            return None;
        }

        let Some(_lease) = self.try_start_recovery() else {
            return Some(self.ad_fallback_manifest(manifest, upstream_url).await);
        };
        let snapshot = self.snapshot().await;
        let attempt = tokio::time::timeout(
            TWITCH_MANIFEST_RECOVERY_BUDGET,
            self.find_ad_replacement(snapshot.clone(), headers),
        )
        .await;
        match attempt {
            Ok(attempt) => {
                let mut state = self.state.lock().await;
                state.fallback_urls = attempt.fallback_urls;
                if let Some((profile_index, replacement)) = attempt.replacement {
                    if state.revision == snapshot.revision {
                        state.active_profile = Some(profile_index);
                        state.last_clean_manifest =
                            Some((replacement.body.clone(), replacement.upstream_url.clone()));
                        state.current_manifest_url = Some(replacement.upstream_url.to_string());
                        state.revision = state.revision.wrapping_add(1);
                    }
                    tracing::debug!(
                        player_type =
                            crate::sites::twitch::TWITCH_AD_FALLBACK_PROFILES[profile_index].0,
                        "Twitch ad playlist replaced"
                    );
                    return Some(replacement);
                }
                state.active_profile = None;
            }
            Err(_) => tracing::warn!(
                budget_ms = TWITCH_MANIFEST_RECOVERY_BUDGET.as_millis(),
                "Twitch 广告清单替换超出响应预算"
            ),
        }

        Some(self.ad_fallback_manifest(manifest, upstream_url).await)
    }

    async fn find_ad_replacement(
        &self,
        snapshot: TwitchAdRecoverySnapshot,
        headers: &HashMap<String, String>,
    ) -> TwitchAdRecoveryAttempt {
        let mut profile_order =
            (0..crate::sites::twitch::TWITCH_AD_FALLBACK_PROFILES.len()).collect::<Vec<_>>();
        if let Some(active) = snapshot.active_profile {
            profile_order.retain(|index| *index != active);
            profile_order.insert(0, active);
        }
        let mut fallback_urls = snapshot.fallback_urls;

        for profile_index in profile_order {
            let (player_type, platform) =
                crate::sites::twitch::TWITCH_AD_FALLBACK_PROFILES[profile_index];
            for attempt in 0..2 {
                let candidate_url = match fallback_urls[profile_index].clone() {
                    Some(url) => url,
                    None => match crate::sites::twitch::twitch_ad_fallback_url(
                        self.client.clone(),
                        &self.config,
                        player_type,
                        platform,
                    )
                    .await
                    {
                        Ok(url) => {
                            fallback_urls[profile_index] = Some(url.clone());
                            url
                        }
                        Err(error) => {
                            tracing::debug!(
                                player_type,
                                code = %error.code,
                                "Twitch ad fallback token request failed"
                            );
                            break;
                        }
                    },
                };

                match fetch_twitch_playlist(&self.client, &candidate_url, headers).await {
                    Ok((body, effective_url)) => {
                        if looks_like_hls_manifest(body.as_bytes()) && !is_twitch_ad_manifest(&body)
                        {
                            return TwitchAdRecoveryAttempt {
                                fallback_urls,
                                replacement: Some((
                                    profile_index,
                                    TwitchManifestReplacement {
                                        body,
                                        upstream_url: effective_url,
                                    },
                                )),
                            };
                        }
                        break;
                    }
                    Err(error) => {
                        fallback_urls[profile_index] = None;
                        if attempt == 0 {
                            continue;
                        }
                        tracing::debug!(player_type, %error, "Twitch ad fallback playlist failed");
                    }
                }
            }
        }

        TwitchAdRecoveryAttempt {
            fallback_urls,
            replacement: None,
        }
    }

    async fn ad_fallback_manifest(
        &self,
        manifest: &str,
        upstream_url: &Url,
    ) -> TwitchManifestReplacement {
        let state = self.state.lock().await;
        let (body, effective_url) = if looks_like_hls_manifest(manifest.as_bytes()) {
            (
                mark_twitch_ad_segments_as_gaps(manifest),
                upstream_url.clone(),
            )
        } else if let Some((last_clean, last_url)) = state.last_clean_manifest.as_ref() {
            (mark_all_hls_segments_as_gaps(last_clean), last_url.clone())
        } else {
            tracing::warn!("Twitch 广告替换与历史清单均不可用，只能返回占位清单");
            (twitch_wait_manifest(), upstream_url.clone())
        };
        TwitchManifestReplacement {
            body,
            upstream_url: effective_url,
        }
    }

    async fn current_manifest_url(&self) -> Option<String> {
        self.state.lock().await.current_manifest_url.clone()
    }

    async fn refresh_manifest(
        &self,
        headers: &HashMap<String, String>,
    ) -> TwitchManifestReplacement {
        let Some(_lease) = self.try_start_recovery() else {
            return self.waiting_manifest().await;
        };
        let snapshot = self.snapshot().await;
        let replacement = tokio::time::timeout(
            TWITCH_MANIFEST_RECOVERY_BUDGET,
            self.find_refreshed_manifest(headers),
        )
        .await;
        match replacement {
            Ok(Some((active_profile, replacement))) => {
                let mut state = self.state.lock().await;
                if state.revision == snapshot.revision {
                    state.active_profile = active_profile;
                    state.current_manifest_url = Some(replacement.upstream_url.to_string());
                    state.last_clean_manifest =
                        Some((replacement.body.clone(), replacement.upstream_url.clone()));
                    state.revision = state.revision.wrapping_add(1);
                }
                tracing::debug!("Twitch manifest URL renewed");
                return replacement;
            }
            Ok(None) => {}
            Err(_) => tracing::warn!(
                budget_ms = TWITCH_MANIFEST_RECOVERY_BUDGET.as_millis(),
                "Twitch 清单续期超出响应预算"
            ),
        }

        self.waiting_manifest().await
    }

    async fn find_refreshed_manifest(
        &self,
        headers: &HashMap<String, String>,
    ) -> Option<(Option<usize>, TwitchManifestReplacement)> {
        let profiles = std::iter::once(crate::sites::twitch::TWITCH_PRIMARY_PLAYER_TYPE)
            .chain(crate::sites::twitch::TWITCH_AD_FALLBACK_PROFILES);
        for (profile_index, (player_type, platform)) in profiles.enumerate() {
            let candidate_url = match crate::sites::twitch::twitch_ad_fallback_url(
                self.client.clone(),
                &self.config,
                player_type,
                platform,
            )
            .await
            {
                Ok(url) => url,
                Err(error) => {
                    tracing::debug!(
                        player_type,
                        code = %error.code,
                        "Twitch manifest renewal token request failed"
                    );
                    continue;
                }
            };
            let Ok((body, effective_url)) =
                fetch_twitch_playlist(&self.client, &candidate_url, headers).await
            else {
                continue;
            };
            if looks_like_hls_manifest(body.as_bytes())
                && !is_twitch_ad_manifest(&body)
                && !body.contains("#EXT-X-ENDLIST")
            {
                return Some((
                    profile_index.checked_sub(1),
                    TwitchManifestReplacement {
                        body,
                        upstream_url: effective_url,
                    },
                ));
            }
        }

        None
    }

    async fn waiting_manifest(&self) -> TwitchManifestReplacement {
        let state = self.state.lock().await;
        let (body, upstream_url) = state
            .last_clean_manifest
            .as_ref()
            .map(|(manifest, url)| (mark_all_hls_segments_as_gaps(manifest), url.clone()))
            .unwrap_or_else(|| {
                tracing::warn!("Twitch 清单续期失败且没有历史清单，只能返回占位清单");
                let url = state
                    .current_manifest_url
                    .as_deref()
                    .and_then(|value| Url::parse(value).ok())
                    .unwrap_or_else(|| Url::parse("https://usher.ttvnw.net/").unwrap());
                (twitch_wait_manifest(), url)
            });
        TwitchManifestReplacement { body, upstream_url }
    }

    async fn snapshot(&self) -> TwitchAdRecoverySnapshot {
        let state = self.state.lock().await;
        TwitchAdRecoverySnapshot {
            fallback_urls: state.fallback_urls.clone(),
            active_profile: state.active_profile,
            revision: state.revision,
        }
    }

    fn try_start_recovery(&self) -> Option<TwitchRecoveryLease<'_>> {
        self.recovery_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| TwitchRecoveryLease {
                in_flight: &self.recovery_in_flight,
            })
    }
}

impl HlsResources {
    const MAX_ENTRIES: usize = 2_048;

    fn new() -> Self {
        Self::with_capacity(Self::MAX_ENTRIES)
    }

    fn with_capacity(max_entries: usize) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            max_entries: max_entries.max(1),
            entries: Mutex::new(HlsResourceEntries {
                by_id: HashMap::new(),
                by_url: HashMap::new(),
                access_order: VecDeque::new(),
            }),
        }
    }

    fn register(&self, url: String) -> u64 {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(&id) = entries.by_url.get(&url) {
            Self::touch(&mut entries, id);
            return id;
        }

        let mut id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            id = self.next_id.fetch_add(1, Ordering::Relaxed);
        }
        entries.by_id.insert(id, url.clone());
        entries.by_url.insert(url, id);
        Self::touch(&mut entries, id);

        while entries.access_order.len() > self.max_entries {
            if let Some(expired) = entries.access_order.pop_front()
                && let Some(expired_url) = entries.by_id.remove(&expired)
                && entries.by_url.get(&expired_url) == Some(&expired)
            {
                entries.by_url.remove(&expired_url);
            }
        }
        id
    }

    fn resolve(&self, id: u64) -> Option<String> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let url = entries.by_id.get(&id).cloned()?;
        Self::touch(&mut entries, id);
        Some(url)
    }

    fn touch(entries: &mut HlsResourceEntries, id: u64) {
        if let Some(index) = entries.access_order.iter().position(|entry| *entry == id) {
            entries.access_order.remove(index);
        }
        entries.access_order.push_back(id);
    }
}

impl Default for StreamProxy {
    fn default() -> Self {
        Self {
            state: Mutex::new(ProxyState::default()),
        }
    }
}

impl Drop for StreamProxy {
    fn drop(&mut self) {
        self.stop();
    }
}

impl StreamProxy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        // 全局停止只在应用关机时使用。清空预订可防止仍在绑定中的监听器
        // 在所有活动任务终止之后又被安装。
        state.pending.clear();
        for (_, inner) in state.active.drain() {
            Self::stop_inner(inner);
        }
    }

    /// 只停止 `session_id` 拥有的监听器/预订。
    ///
    /// 路由卸载清理是异步的。没有这个归属检查，旧房间可能在快速重进已经启动新
    /// 代理之后才完成它的 `stream_proxy_stop` 命令，导致播放器黑屏。
    pub fn stop_for_session(&self, session_id: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let cancelled_pending = state.pending.remove(session_id).is_some();
        let stopped_active = state.active.remove(session_id).map(|inner| {
            Self::stop_inner(inner);
        });
        cancelled_pending || stopped_active.is_some()
    }

    /// 只为活动拥有者返回聚合计数器。诊断契约刻意不包含
    /// URL 和请求头。
    pub fn telemetry_for_session(&self, session_id: &str) -> Option<StreamProxyTelemetry> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state
            .active
            .get(session_id)
            .map(|inner| inner.telemetry.snapshot())
    }

    /// 用 `headers` 为 `url` 启动（或替换）一个代理。返回本地播放 URL。
    pub async fn start(
        &self,
        url: String,
        headers: HashMap<String, String>,
        session_id: String,
        force_hls: bool,
        proxy: Option<&str>,
        twitch_ad_recovery: Option<TwitchAdRecovery>,
    ) -> AppResult<String> {
        // 在第一次 await 之前完成所有权预订。后续的 start 或 stop 可以取代这次预订，
        // 此时当前请求丢弃自己未安装的监听器，
        // 而不是覆盖更新的任务。
        let generation = self.reserve_start(&session_id);

        // 每个代理都使用临时端口，无需等待前一个套接字的端口变为可复用。
        // 避免那个 sleep 同样重要：它曾扩大进入/退出/重进的竞争窗口。
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(e) => {
                self.clear_pending(&session_id, generation);
                return Err(AppError::new(
                    "stream_proxy_bind",
                    format!("bind localhost failed: {e}"),
                )
                .retryable());
            }
        };
        let port = listener
            .local_addr()
            .map_err(|e| {
                self.clear_pending(&session_id, generation);
                AppError::new("stream_proxy_bind", e.to_string())
            })?
            .port();
        // MSE 协议插件可能为一场直播发出多个本机请求。在每个代理生命周期内构建一个
        // 客户端，使这些请求共享其连接池，
        // 而不是每个请求都重建 TLS/连接池状态。
        let client = match build_stream_client(proxy) {
            Ok(client) => client,
            Err(error) => {
                self.clear_pending(&session_id, generation);
                return Err(error);
            }
        };
        let twitch_ad_recovery = match twitch_ad_recovery {
            Some(config) => {
                let recovery_client = match crate::http_client::build_client(proxy) {
                    Ok(client) => client,
                    Err(error) => {
                        self.clear_pending(&session_id, generation);
                        return Err(error);
                    }
                };
                Some(Arc::new(TwitchAdRecoverySession::new(
                    config,
                    recovery_client,
                )))
            }
            None => None,
        };

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let is_current = state.pending.get(&session_id) == Some(&generation);
        if !is_current {
            // `listener` 尚未 spawn，丢弃它即可释放套接字。
            // 不要触碰更新的预订/任务。
            return Err(AppError::new(
                "stream_proxy_superseded",
                "playback session was replaced before proxy startup finished",
            )
            .retryable());
        }

        let hls_resources = Arc::new(HlsResources::new());
        let telemetry = Arc::new(ProxyTelemetryCounters::new());
        let local_origin = Arc::<str>::from(format!("http://127.0.0.1:{port}"));
        let context = ProxyLoopContext {
            client,
            url: Arc::<str>::from(url),
            headers: Arc::new(headers),
            hls_resources,
            local_origin,
            force_hls,
            twitch_ad_recovery,
            telemetry: telemetry.clone(),
        };
        let task = tauri::async_runtime::spawn(async move {
            run_proxy_loop(listener, context, shutdown_rx).await;
        });
        // 让本会话的旧监听器保持存活，直到它的替代者完全绑定并构建好网络客户端。
        // 其他会话不受影响。
        if let Some(previous) = state.active.remove(&session_id) {
            Self::stop_inner(previous);
        }
        state.pending.remove(&session_id);
        state.active.insert(
            session_id,
            ProxyInner {
                shutdown: shutdown_tx,
                task,
                telemetry,
            },
        );
        Ok(format!("http://127.0.0.1:{port}/live"))
    }

    /// 阻塞直到该代理的 `/live` 端点应答出一份一次性解复用器能打开的播放列表，
    /// 或直到 `budget` 耗尽。
    ///
    /// [`Self::start`] 只绑定监听器，从不抓取 `/live`。浏览器播放器能容忍这一点，
    /// 因为它会不断重新加载播放列表直到出现媒体；而 libavformat 只调用一次
    /// `avformat_open_input`。如果那唯一一次响应是 Twitch 恢复路径发出的
    /// 纯 gap 等待清单 —— 广告插播期间、token 过期或上游失败之后 ——
    /// 每个分片都是 `#EXT-X-GAP` 占位符，解复用器找不到任何可读数据，
    /// 整场录制在写入一个字节之前就以
    /// `Invalid data found when processing input` 失败。
    /// 因此录制在这里预热代理，只把已证明能提供真实分片的 URL 交给 ffmpeg。
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub async fn wait_for_playable_manifest(
        &self,
        local_url: &str,
        session_id: &str,
        budget: Duration,
    ) -> AppResult<()> {
        let client = build_loopback_client()?;
        let deadline = Instant::now() + budget;
        let mut attempts = 0_u32;
        // 下方轮询的每条路径都记录了那次尝试失败的原因，
        // 因此超时可以指出最后一个真实原因，而不是占位符。
        let mut last_reason: String;
        loop {
            // 预热期间的 stop 或替代性 start 会移除该监听器；
            // 对着死端口轮询到预算耗尽，
            // 只会拖延调用方已经做出的决定。
            if self.telemetry_for_session(session_id).is_none() {
                return Err(AppError::new(
                    "stream_proxy_superseded",
                    "录制清单代理在预热期间已被停止",
                ));
            }
            attempts = attempts.saturating_add(1);
            match client.get(local_url).send().await {
                Ok(response) if response.status().is_success() => {
                    let body = response.text().await.unwrap_or_default();
                    if manifest_has_playable_segment(&body) {
                        return Ok(());
                    }
                    last_reason = format!(
                        "清单只包含 {} 个占位分片",
                        body.matches("#EXT-X-GAP").count()
                    );
                }
                Ok(response) => last_reason = format!("HTTP {}", response.status().as_u16()),
                Err(_) => last_reason = "本地清单请求失败".into(),
            }
            if Instant::now() + TWITCH_RECORDING_WARMUP_INTERVAL >= deadline {
                tracing::warn!(
                    attempts,
                    reason = %last_reason,
                    "Twitch 录制清单预热超时，未取得可录制的分片"
                );
                return Err(AppError::new(
                    "stream_proxy_no_playable_manifest",
                    format!("直播清单暂时没有可录制的分片（{last_reason}）"),
                )
                .retryable());
            }
            tokio::time::sleep(TWITCH_RECORDING_WARMUP_INTERVAL).await;
        }
    }

    /// 为 `session_id` 预订下一代。活动监听器保持可用，
    /// 直到替代者完成绑定并构建好网络客户端。
    fn reserve_start(&self, session_id: &str) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let generation = Self::advance_generation(&mut state);
        state.pending.insert(session_id.to_string(), generation);
        generation
    }

    fn clear_pending(&self, session_id: &str, generation: u64) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.pending.get(session_id) == Some(&generation) {
            state.pending.remove(session_id);
        }
    }

    fn advance_generation(state: &mut ProxyState) -> u64 {
        state.generation = state.generation.wrapping_add(1);
        // 如今 `0` 并无特殊含义，但让生成的取值保持非零，
        // 可在回绕后减少未来诊断和可选 id 的意外。
        if state.generation == 0 {
            state.generation = 1;
        }
        state.generation
    }

    fn stop_inner(inner: ProxyInner) {
        // accept 循环通过 JoinSet 持有全部 handler。发送成功后它可以取消并排空这些
        // handler；如果接收方已经不在，则中止剩余的顶层任务作为最后兜底。
        if inner.shutdown.send(true).is_err() {
            inner.task.abort();
        }
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use reqwest::Url;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{
        HlsResources, ProxyInner, ProxyTelemetryCounters, StreamProxy, TwitchAdRecoverySession,
        hls_path_extension, is_twitch_ad_manifest, looks_like_hls_manifest,
        manifest_has_playable_segment, mark_all_hls_segments_as_gaps,
        mark_twitch_ad_segments_as_gaps, probe_sources, resolve_upstream_target,
        rewrite_hls_manifest, twitch_wait_manifest, validate_probe_sample,
    };
    use crate::models::live::{PlayUrl, PlaybackProtocol, TwitchAdRecovery};
    use tokio::sync::{oneshot, watch};

    #[test]
    fn independent_active_sessions_stop_separately() {
        let proxy = StreamProxy::new();
        let (shutdown_a, _) = watch::channel(false);
        let task_a = tauri::async_runtime::spawn(async {
            std::future::pending::<()>().await;
        });
        let (shutdown_b, _) = watch::channel(false);
        let task_b = tauri::async_runtime::spawn(async {
            std::future::pending::<()>().await;
        });
        {
            let mut state = proxy.state.lock().unwrap_or_else(|p| p.into_inner());
            state.active.insert(
                "room-a:1".to_string(),
                ProxyInner {
                    shutdown: shutdown_a,
                    task: task_a,
                    telemetry: Arc::new(ProxyTelemetryCounters::new()),
                },
            );
            state.active.insert(
                "room-b:2".to_string(),
                ProxyInner {
                    shutdown: shutdown_b,
                    task: task_b,
                    telemetry: Arc::new(ProxyTelemetryCounters::new()),
                },
            );
        }

        assert!(!proxy.stop_for_session("old-room:0"));
        assert!(proxy.stop_for_session("room-a:1"));
        assert!(proxy.telemetry_for_session("room-a:1").is_none());
        assert!(proxy.telemetry_for_session("room-b:2").is_some());
        assert_eq!(
            proxy
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .active
                .len(),
            1
        );
        proxy.stop();
    }

    #[test]
    fn start_reservations_are_isolated_by_session() {
        let proxy = StreamProxy::new();
        let first = proxy.reserve_start("room-a:1");
        let second = proxy.reserve_start("room-b:2");
        let replacement = proxy.reserve_start("room-a:1");

        let state = proxy.state.lock().unwrap_or_else(|p| p.into_inner());
        assert_ne!(first, second);
        assert_ne!(first, replacement);
        assert_eq!(state.pending.get("room-a:1"), Some(&replacement));
        assert_eq!(state.pending.get("room-b:2"), Some(&second));
        assert_eq!(state.pending.len(), 2);
    }

    #[test]
    fn matching_stop_cancels_a_pending_start() {
        let proxy = StreamProxy::new();
        let generation = proxy.reserve_start("room-a:1");

        assert!(proxy.stop_for_session("room-a:1"));
        let state = proxy.state.lock().unwrap_or_else(|p| p.into_inner());
        assert!(!state.pending.contains_key("room-a:1"));
        assert_eq!(state.generation, generation);
    }

    #[test]
    fn a_replacement_reservation_keeps_the_active_proxy_alive() {
        let proxy = StreamProxy::new();
        let (shutdown, _) = watch::channel(false);
        let task = tauri::async_runtime::spawn(async {
            std::future::pending::<()>().await;
        });
        {
            let mut state = proxy.state.lock().unwrap_or_else(|p| p.into_inner());
            state.active.insert(
                "room-a:1".into(),
                ProxyInner {
                    shutdown,
                    task,
                    telemetry: Arc::new(ProxyTelemetryCounters::new()),
                },
            );
        }

        proxy.reserve_start("room-a:1");

        assert!(
            proxy
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .active
                .contains_key("room-a:1")
        );
        proxy.stop();
    }

    #[tokio::test]
    async fn distinct_sessions_bind_independent_loopback_listeners() {
        let proxy = StreamProxy::new();
        let first_url = proxy
            .start(
                "https://first.invalid/live.flv".into(),
                HashMap::new(),
                "room-a:1".into(),
                false,
                None,
                None,
            )
            .await
            .unwrap();
        let second_url = proxy
            .start(
                "https://second.invalid/live.flv".into(),
                HashMap::new(),
                "room-b:1".into(),
                false,
                None,
                None,
            )
            .await
            .unwrap();

        assert_ne!(
            Url::parse(&first_url).unwrap().port(),
            Url::parse(&second_url).unwrap().port()
        );
        assert!(proxy.telemetry_for_session("room-a:1").is_some());
        assert!(proxy.telemetry_for_session("room-b:1").is_some());
        assert!(proxy.stop_for_session("room-a:1"));
        assert!(proxy.telemetry_for_session("room-a:1").is_none());
        assert!(proxy.telemetry_for_session("room-b:1").is_some());
        proxy.stop();
    }

    #[test]
    fn hls_manifest_rewrites_relative_segments_and_uri_attributes() {
        let resources = HlsResources::new();
        let upstream = Url::parse("https://media.example.test/live/master.m3u8").unwrap();
        let manifest = concat!(
            "#EXTM3U\n",
            "#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key.bin\"\n",
            "variant/720p.m3u8\n",
            "segment-001.ts\n"
        );

        let rewritten =
            rewrite_hls_manifest(manifest, &upstream, "http://127.0.0.1:41500", &resources);

        assert!(rewritten.contains("URI=\"http://127.0.0.1:41500/hls/1.bin\""));
        assert!(rewritten.contains("http://127.0.0.1:41500/hls/2.m3u8"));
        assert!(rewritten.contains("http://127.0.0.1:41500/hls/3.ts"));
        assert_eq!(
            resources.resolve(2).as_deref(),
            Some("https://media.example.test/live/variant/720p.m3u8")
        );
    }

    #[test]
    fn rewritten_segment_urls_carry_an_extension_ffmpeg_will_open() {
        let resources = HlsResources::new();
        let upstream = Url::parse("https://video-weaver.example/live/chunked/index.m3u8").unwrap();
        // Twitch 的 fMP4 分片：扩展名之后跟着签名 query，
        // 绝不能让它进入本地路径。
        let manifest = concat!(
            "#EXTM3U\n",
            "#EXT-X-MAP:URI=\"https://cdn.example/v1/segment/init.mp4?dna=SECRET\"\n",
            "#EXTINF:2.000,live\n",
            "https://cdn.example/v1/segment/AAAA.mp4?dna=SECRET\n",
            "#EXTINF:2.000,live\n",
            "https://cdn.example/v1/segment/opaque\n",
        );

        let rewritten =
            rewrite_hls_manifest(manifest, &upstream, "http://127.0.0.1:41500", &resources);

        // FFmpeg 8+ 默认启用 `extension_picky`，拒绝扩展名不在白名单内的分片，
        // 因此没有扩展名的 URL 会直接导致 `avformat_open_input` 失败。
        assert!(
            rewritten.contains("URI=\"http://127.0.0.1:41500/hls/1.mp4\""),
            "init segment kept no extension: {rewritten}"
        );
        assert!(rewritten.contains("http://127.0.0.1:41500/hls/2.mp4"));
        // 没有任何可识别内容可以继承时保持无扩展名，而不是编造一个扩展名。
        assert!(rewritten.contains("http://127.0.0.1:41500/hls/3\n"));
        assert!(
            !rewritten.contains("dna=SECRET\n") && !rewritten.contains("/hls/2.mp4?dna"),
            "the signed query leaked into a local URL: {rewritten}"
        );
    }

    #[test]
    fn an_extended_hls_path_resolves_to_the_same_registry_entry() {
        let resources = HlsResources::new();
        let id = resources.register("https://cdn.example/segment.mp4?dna=SECRET".into());

        assert_eq!(
            resolve_upstream_target(&format!("/hls/{id}.mp4"), "http://unused/live", &resources)
                .as_deref(),
            Ok("https://cdn.example/segment.mp4?dna=SECRET")
        );
        // 先前签发的清单可能仍引用裸形态，保持其可用；非数字 id 仍然被拒绝。
        assert_eq!(
            resolve_upstream_target(&format!("/hls/{id}"), "http://unused/live", &resources)
                .as_deref(),
            Ok("https://cdn.example/segment.mp4?dna=SECRET")
        );
        assert!(resolve_upstream_target("/hls/x.mp4", "http://unused/live", &resources).is_err());
    }

    #[test]
    fn only_a_short_alphanumeric_path_extension_is_carried_over() {
        let extension =
            |url: &str| hls_path_extension(&Url::parse(url).unwrap()).unwrap_or_default();

        assert_eq!(extension("https://cdn.example/a/b.ts?token=x.y"), "ts");
        assert_eq!(extension("https://cdn.example/a/b.M3U8"), "m3u8");
        // 无扩展名、过长扩展名和非字母数字扩展名都不会进入本地路径。
        assert_eq!(extension("https://cdn.example/a/segment"), "");
        assert_eq!(extension("https://cdn.example/a/b.superlong"), "");
        assert_eq!(extension("https://cdn.example/a/b.ts%2f"), "");
        assert_eq!(extension("https://cdn.example/"), "");
    }

    #[test]
    fn hls_resource_registry_keeps_a_refreshed_child_playlist_alive() {
        // 播放器每次重载都会请求选中的子播放列表，而分片 URL 会持续进入有界注册表。
        // 播放列表必须在被访问时提升优先级，
        // 否则最终会变成 404。
        let resources = HlsResources::with_capacity(3);
        let playlist = resources.register("https://cdn.example.test/live/index.m3u8".into());
        let first_segment = resources.register("https://cdn.example.test/live/001.ts".into());
        resources.register("https://cdn.example.test/live/002.ts".into());

        assert_eq!(
            resources.resolve(playlist).as_deref(),
            Some("https://cdn.example.test/live/index.m3u8")
        );
        resources.register("https://cdn.example.test/live/003.ts".into());

        assert_eq!(
            resources.resolve(playlist).as_deref(),
            Some("https://cdn.example.test/live/index.m3u8")
        );
        assert!(resources.resolve(first_segment).is_none());
        assert_eq!(
            resources.register("https://cdn.example.test/live/index.m3u8".into()),
            playlist
        );
    }

    #[test]
    fn hls_sniff_accepts_bom_and_rejects_transport_stream_bytes() {
        assert!(looks_like_hls_manifest(
            b"\xef\xbb\xbf\n#EXTM3U\n#EXT-X-VERSION:3\n"
        ));
        assert!(!looks_like_hls_manifest(&[0x47, 0x40, 0x00, 0x10]));
    }

    #[test]
    fn twitch_ad_detection_covers_stitched_playlists_and_commercial_responses() {
        assert!(is_twitch_ad_manifest(
            "#EXTM3U\n#EXT-X-DATERANGE:ID=\"stitched-ad-123\"\n"
        ));
        assert!(is_twitch_ad_manifest("Commercial break in progress"));
        assert!(is_twitch_ad_manifest("COMMERCIAL BREAK IN PROGRESS"));
        assert!(!is_twitch_ad_manifest(
            "#EXTM3U\n#EXTINF:2.000,live\nlive.ts\n"
        ));
    }

    #[test]
    fn twitch_ad_detection_reads_the_stream_source_daterange() {
        // 直播渲染档以 `live` 作为来源名，必须原样保留，
        // 即使清单中还带有无关的 DATERANGE 行。
        assert!(!is_twitch_ad_manifest(concat!(
            "#EXTM3U\n",
            "#EXT-X-DATERANGE:ID=\"playlist-creation-1\",CLASS=\"timestamp\"\n",
            "#EXT-X-DATERANGE:ID=\"source-1\",CLASS=\"twitch-stream-source\",",
            "X-TV-TWITCH-STREAM-SOURCE=\"live\"\n",
            "#EXTINF:2.000,live\nlive.ts\n"
        )));
        // 广告时段会写明自己的来源名，这是在 Twitch 省略 `stitched` 标记时
        // 仍然有效的信号。
        assert!(is_twitch_ad_manifest(concat!(
            "#EXTM3U\n",
            "#EXT-X-DATERANGE:ID=\"source-2\",CLASS=\"twitch-stream-source\",",
            "X-TV-TWITCH-STREAM-SOURCE=\"midroll\"\n",
            "#EXTINF:2.000,\nad.ts\n"
        )));
        // END-ON-NEXT 关闭较早的来源区间。滚动窗口可能在新 live 行恢复之后
        // 短暂保留广告行。
        assert!(!is_twitch_ad_manifest(concat!(
            "#EXTM3U\n",
            "#EXT-X-DATERANGE:ID=\"source-ad\",CLASS=\"twitch-stream-source\",",
            "END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE=\"Amazon|old-ad\"\n",
            "#EXT-X-DATERANGE:ID=\"source-live\",CLASS=\"twitch-stream-source\",",
            "END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE=\"live\"\n",
            "#EXTINF:2.000,live\nlive.ts\n"
        )));
    }

    #[test]
    fn twitch_ad_detection_matches_a_captured_live_commercial_break() {
        // 从四个频道同时处于广告时段（2026-08-11）时捕获的真实 `site/web`
        // 播放列表裁剪而来。Twitch 把广告来源命名为 `Amazon|<creative id>` 并用它
        // 标记分片，却完全没有"Commercial break in progress"文本 ——
        // 这正是纯文本检查会漏掉、而 DATERANGE 来源能抓住的情况。
        let captured = concat!(
            "#EXTM3U\n",
            "#EXT-X-DATERANGE:ID=\"playlist-session-1786466727\",CLASS=\"twitch-session\",",
            "END-ON-NEXT=YES,X-TV-TWITCH-SESSIONID=\"1723543675029225621\"\n",
            "#EXT-X-DATERANGE:ID=\"source-1786466722\",CLASS=\"twitch-stream-source\",",
            "END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE=\"Amazon|2474283100494\"\n",
            "#EXT-X-DISCONTINUITY\n",
            "#EXTINF:2.000,Amazon|2474283100494\n",
            "ad-0.ts\n",
            "#EXTINF:2.000,Amazon|2474283100494\n",
            "ad-1.ts\n",
        );
        assert!(is_twitch_ad_manifest(captured));
        assert!(looks_like_hls_manifest(captured.as_bytes()));

        // 广告结束后同一频道的样子：结构相同、来源为 `live`，
        // 不得被当作广告。
        let resumed = captured.replace("Amazon|2474283100494", "live");
        assert!(!is_twitch_ad_manifest(&resumed));
    }

    #[test]
    fn twitch_ad_segments_become_hls_gaps_without_hiding_live_segments() {
        let manifest = concat!(
            "#EXTM3U\n",
            "#EXTINF:2.000,\n",
            "ad.ts\n",
            "#EXTINF:2.000,live\n",
            "live.ts\n",
            "#EXT-X-TWITCH-PREFETCH:next-ad.ts\n"
        );

        let filtered = mark_twitch_ad_segments_as_gaps(manifest);
        assert_eq!(filtered.matches("#EXT-X-GAP").count(), 1);
        assert!(filtered.contains("#EXTINF:2.000,\n#EXT-X-GAP\nad.ts"));
        assert!(filtered.contains("#EXTINF:2.000,live\nlive.ts"));
        assert!(!filtered.contains("PREFETCH"));

        let all_gaps = mark_all_hls_segments_as_gaps(manifest);
        assert_eq!(all_gaps.matches("#EXT-X-GAP").count(), 2);
    }

    #[test]
    fn twitch_wait_response_is_a_valid_gap_playlist() {
        let manifest = twitch_wait_manifest();
        assert!(looks_like_hls_manifest(manifest.as_bytes()));
        assert!(manifest.contains("#EXT-X-TARGETDURATION:2"));
        assert!(manifest.contains("#EXT-X-GAP"));
    }

    /// 可播放性检查的唯一目的就是不让纯 gap 播放列表到达 `avformat_open_input`，
    /// 因此恢复路径发出的等待清单和完全 gap 化的干净清单都必须判为不可播放。
    #[test]
    fn placeholder_only_playlists_are_not_playable() {
        assert!(!manifest_has_playable_segment(&twitch_wait_manifest()));

        let clean = concat!(
            "#EXTM3U\n",
            "#EXT-X-VERSION:6\n",
            "#EXT-X-TARGETDURATION:2\n",
            "#EXTINF:2.000,live\n",
            "https://cdn.example.test/1.ts\n",
            "#EXTINF:2.000,live\n",
            "https://cdn.example.test/2.ts\n"
        );
        assert!(manifest_has_playable_segment(clean));
        assert!(!manifest_has_playable_segment(
            &mark_all_hls_segments_as_gaps(clean)
        ));

        // 只把广告分片 gap 掉的广告时段仍然带有可录制的媒体。
        let partial = concat!(
            "#EXTM3U\n",
            "#EXTINF:2.000,\n",
            "https://cdn.example.test/ad.ts\n",
            "#EXTINF:2.000,live\n",
            "https://cdn.example.test/3.ts\n"
        );
        assert!(manifest_has_playable_segment(
            &mark_twitch_ad_segments_as_gaps(partial)
        ));

        // 仅有 init 分片不算媒体，非清单 body 也不算。
        assert!(!manifest_has_playable_segment(concat!(
            "#EXTM3U\n",
            "#EXT-X-MAP:URI=\"https://cdn.example.test/init.mp4\"\n"
        )));
        assert!(!manifest_has_playable_segment("<html>error</html>"));
    }

    /// 录制绝不能把只有占位符应答的 URL 交给 ffmpeg：
    /// 解复用器只打开一次，找不到媒体就判定整场会话失败。
    #[tokio::test]
    async fn warmup_rejects_a_proxy_that_only_serves_gap_playlists() {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = upstream.accept().await else {
                    return;
                };
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request).await;
                let body = super::twitch_wait_manifest();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });

        let proxy = StreamProxy::new();
        let session_id = "recording:gap-only";
        let local_url = proxy
            .start(
                format!("http://{upstream_address}/live.m3u8"),
                HashMap::new(),
                session_id.into(),
                true,
                None,
                None,
            )
            .await
            .unwrap();

        let error = proxy
            .wait_for_playable_manifest(&local_url, session_id, std::time::Duration::from_secs(3))
            .await
            .expect_err("a gap-only playlist must not be accepted for recording");
        assert_eq!(error.code, "stream_proxy_no_playable_manifest");
        proxy.stop_for_session(session_id);
        server.abort();
    }

    /// 同样的预热只要真实分片可用就必须立即返回，
    /// 让健康的频道不必付出整个预算就能开始录制。
    #[tokio::test]
    async fn warmup_accepts_a_playlist_that_carries_real_segments() {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = upstream.accept().await else {
                    return;
                };
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request).await;
                let body = concat!(
                    "#EXTM3U\n",
                    "#EXT-X-VERSION:6\n",
                    "#EXT-X-TARGETDURATION:2\n",
                    "#EXTINF:2.000,live\n",
                    "1.ts\n"
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });

        let proxy = StreamProxy::new();
        let session_id = "recording:playable";
        let local_url = proxy
            .start(
                format!("http://{upstream_address}/live.m3u8"),
                HashMap::new(),
                session_id.into(),
                true,
                None,
                None,
            )
            .await
            .unwrap();

        proxy
            .wait_for_playable_manifest(&local_url, session_id, std::time::Duration::from_secs(20))
            .await
            .expect("a playlist with real segments must be accepted");
        proxy.stop_for_session(session_id);
        server.abort();
    }

    /// 预热期间停止录制必须立即结束等待，
    /// 而不是对着死监听器轮询到预算耗尽。
    #[tokio::test]
    async fn warmup_ends_when_the_session_is_stopped() {
        let proxy = StreamProxy::new();
        let session_id = "recording:stopped";
        let local_url = proxy
            .start(
                "http://unreachable.invalid/live.m3u8".into(),
                HashMap::new(),
                session_id.into(),
                true,
                None,
                None,
            )
            .await
            .unwrap();
        proxy.stop_for_session(session_id);

        let error = proxy
            .wait_for_playable_manifest(&local_url, session_id, std::time::Duration::from_secs(20))
            .await
            .expect_err("a stopped session must not keep warming up");
        assert_eq!(error.code, "stream_proxy_superseded");
    }

    /// 保持一个已预热、形态与录制一致的代理供*外部*解复用器指向。
    /// 在 stdout 打印 `PROXY_URL=`。运行时传入
    /// `TWITCH_VARIANT_URL=<variant playlist>` 和可选的
    /// `RLIVE_PROXY_HOLD_SECS`。
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "holds a live Twitch recording proxy open for external probing"]
    async fn live_twitch_recording_proxy_stays_open_for_external_probe() {
        let variant = std::env::var("TWITCH_VARIANT_URL").expect("TWITCH_VARIANT_URL");
        let hold = std::env::var("RLIVE_PROXY_HOLD_SECS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(90);
        let mut headers = HashMap::new();
        headers.insert(
            "user-agent".to_string(),
            crate::sites::twitch::DEFAULT_USER_AGENT.to_string(),
        );
        headers.insert(
            "referer".to_string(),
            "https://www.twitch.tv/dota2ti".to_string(),
        );
        let proxy = StreamProxy::new();
        let session_id = "recording:hold";
        let local = proxy
            .start(
                variant,
                headers,
                session_id.into(),
                true,
                None,
                Some(crate::models::live::TwitchAdRecovery {
                    login: "dota2ti".into(),
                    selector: "video-group:chunked".into(),
                    target_width: 1920,
                    target_height: 1080,
                    target_frame_rate_milli: 60_000,
                }),
            )
            .await
            .expect("recording proxy");
        proxy
            .wait_for_playable_manifest(&local, session_id, super::TWITCH_RECORDING_WARMUP_BUDGET)
            .await
            .expect("warm-up");
        println!("PROXY_URL={local}");
        tokio::time::sleep(std::time::Duration::from_secs(hold)).await;
        proxy.stop_for_session(session_id);
    }

    /// 经真实录制路径（录制代理 + 预热 + libavformat）从直播频道录制数秒，
    /// 并断言磁盘上落下一个非平凡的文件。
    /// 运行时传入 `TWITCH_VARIANT_URL=<variant playlist>`。
    ///
    /// 必须使用 `flavor = "multi_thread"`：ffmpeg 由阻塞的 `Command` 驱动，
    /// 在 current-thread 运行时上会饿死代理自己的 accept 循环，
    /// 使 ffmpeg 的请求滞留在监听队列里。
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "live Twitch recording; requires TWITCH_VARIANT_URL and external network"]
    async fn live_twitch_recording_writes_media_through_the_warmed_proxy() {
        let variant = std::env::var("TWITCH_VARIANT_URL").expect("TWITCH_VARIANT_URL");
        let mut headers = HashMap::new();
        headers.insert(
            "user-agent".to_string(),
            crate::sites::twitch::DEFAULT_USER_AGENT.to_string(),
        );
        headers.insert(
            "referer".to_string(),
            "https://www.twitch.tv/dota2ti".to_string(),
        );
        let proxy = StreamProxy::new();
        let session_id = "recording:live-warmup";
        let local = proxy
            .start(
                variant,
                headers,
                session_id.into(),
                true,
                None,
                Some(crate::models::live::TwitchAdRecovery {
                    login: "dota2ti".into(),
                    selector: "video-group:chunked".into(),
                    target_width: 1920,
                    target_height: 1080,
                    target_frame_rate_milli: 60_000,
                }),
            )
            .await
            .expect("recording proxy");
        let warmed = std::time::Instant::now();
        proxy
            .wait_for_playable_manifest(&local, session_id, super::TWITCH_RECORDING_WARMUP_BUDGET)
            .await
            .expect("warm-up should find real segments on a live channel");
        eprintln!("warmup_ms={}", warmed.elapsed().as_millis());

        let output = std::env::temp_dir().join("rlive-live-warmup.ts");
        let _ = std::fs::remove_file(&output);
        let ffmpeg_input = local.clone();
        let ffmpeg_output = output.clone();
        let status = tokio::task::spawn_blocking(move || {
            std::process::Command::new("ffmpeg")
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-live_start_index",
                    "-1",
                    "-probesize",
                    "8000000",
                    "-analyzeduration",
                    "10000000",
                    "-fflags",
                    "+discardcorrupt",
                    "-i",
                    &ffmpeg_input,
                    "-t",
                    "6",
                    "-c",
                    "copy",
                    "-f",
                    "mpegts",
                    "-y",
                ])
                .arg(&ffmpeg_output)
                .status()
        })
        .await
        .expect("ffmpeg task")
        .expect("ffmpeg");
        let size = std::fs::metadata(&output)
            .map(|meta| meta.len())
            .unwrap_or(0);
        eprintln!("ffmpeg status={status} bytes={size}");
        proxy.stop_for_session(session_id);
        assert!(status.success(), "ffmpeg failed against the warmed proxy");
        assert!(size > 512 * 1024, "recording was too small: {size} bytes");
        let _ = std::fs::remove_file(&output);
    }

    /// 针对直播频道端到端重现录制交接：真实代理、`force_hls = true`、附加 Twitch
    /// 恢复逻辑，然后访问改写后的主清单指向的每一个 URL。
    /// 运行时传入 `TWITCH_VARIANT_URL=<variant playlist>`。
    #[tokio::test]
    #[ignore = "live Twitch recording hand-off; requires TWITCH_VARIANT_URL and external network"]
    async fn live_twitch_recording_proxy_serves_a_playable_manifest() {
        let variant = std::env::var("TWITCH_VARIANT_URL").expect("TWITCH_VARIANT_URL");
        let mut headers = HashMap::new();
        headers.insert(
            "user-agent".to_string(),
            crate::sites::twitch::DEFAULT_USER_AGENT.to_string(),
        );
        headers.insert(
            "referer".to_string(),
            "https://www.twitch.tv/dota2ti".to_string(),
        );
        let proxy = StreamProxy::new();
        let local = proxy
            .start(
                variant,
                headers,
                "recording:live-smoke".into(),
                true,
                None,
                Some(crate::models::live::TwitchAdRecovery {
                    login: "dota2ti".into(),
                    selector: "video-group:chunked".into(),
                    target_width: 1920,
                    target_height: 1080,
                    target_frame_rate_milli: 60_000,
                }),
            )
            .await
            .expect("recording proxy");
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client");

        let response = client.get(&local).send().await.expect("primary request");
        let status = response.status();
        let manifest = response.text().await.expect("primary body");
        eprintln!("primary status={status} bytes={}", manifest.len());
        eprintln!(
            "gap markers={} first lines:\n{}",
            manifest.matches("#EXT-X-GAP").count(),
            manifest.lines().take(6).collect::<Vec<_>>().join("\n")
        );

        let targets = manifest
            .lines()
            .flat_map(|line| {
                let trimmed = line.trim();
                if trimmed.starts_with("#EXT-X-MAP:") {
                    return trimmed
                        .split_once("URI=\"")
                        .and_then(|(_, rest)| rest.split_once('"'))
                        .map(|(url, _)| url.to_string())
                        .into_iter()
                        .collect::<Vec<_>>();
                }
                if trimmed.starts_with("http") {
                    return vec![trimmed.to_string()];
                }
                Vec::new()
            })
            .take(3)
            .collect::<Vec<_>>();
        assert!(!targets.is_empty(), "no fetchable target in the manifest");
        for target in targets {
            let response = client.get(&target).send().await.expect("segment request");
            let status = response.status();
            let bytes = response.bytes().await.map(|body| body.len()).unwrap_or(0);
            eprintln!("segment {target} -> {status} bytes={bytes}");
            assert!(status.is_success(), "segment failed: {status}");
            assert!(bytes > 0, "segment was empty");
        }
        proxy.stop_for_session("recording:live-smoke");
    }

    #[tokio::test]
    #[ignore = "live Kai Cenat commercial-break replacement; requires channel and external network"]
    async fn live_kaicenat_commercial_break_replacement_smoke() {
        // 兜底 profile 只有在频道开播时才能签发播放列表；下播时每个 profile 都无可
        // 替换而返回空，恢复逻辑正确地降级为等待清单。此时跳过测试，
        // 不要把这种预期中的降级报告成代理回归。
        use crate::sites::traits::LiveSite;

        let probe = crate::sites::twitch::TwitchSite::new(
            crate::http_client::build_client(None).expect("Twitch probe client"),
        );
        let detail = probe
            .get_room_detail("kaicenat")
            .await
            .expect("Kai Cenat room detail");
        if !detail.status {
            eprintln!("Kai Cenat is offline; skipping live commercial-break replacement probe");
            return;
        }

        let recovery = TwitchAdRecoverySession::new(
            TwitchAdRecovery {
                login: "kaicenat".into(),
                selector: "video-group:chunked".into(),
                target_width: 1920,
                target_height: 1080,
                target_frame_rate_milli: 60_000,
            },
            crate::http_client::build_client(None).expect("Twitch recovery client"),
        );
        let mut headers = HashMap::new();
        headers.insert(
            "user-agent".into(),
            crate::sites::twitch::DEFAULT_USER_AGENT.into(),
        );
        headers.insert("referer".into(), "https://www.twitch.tv/kaicenat".into());

        let replacement = recovery
            .replace_ad_manifest(
                "Commercial break in progress",
                &Url::parse("https://video-weaver.example/kaicenat/chunked/index.m3u8").unwrap(),
                &headers,
            )
            .await
            .expect("commercial response must be replaced");

        assert!(looks_like_hls_manifest(replacement.body.as_bytes()));
        assert!(!is_twitch_ad_manifest(&replacement.body));
        assert!(
            !replacement.body.contains("#EXT-X-GAP"),
            "expected a real Kai Cenat fallback playlist, not the wait manifest"
        );
        eprintln!(
            "Kai Cenat commercial-break response replaced from host {}",
            replacement.upstream_url.host_str().unwrap_or("unknown")
        );
    }

    #[tokio::test]
    async fn concurrent_twitch_refresh_returns_wait_manifest_while_owner_is_blocked() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_seen_tx, request_seen_rx) = oneshot::channel();
        let proxy_server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).await.unwrap();
            assert!(length > 0);
            let _ = request_seen_tx.send(());
            std::future::pending::<()>().await;
        });
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
            .build()
            .unwrap();
        let recovery = Arc::new(TwitchAdRecoverySession::new(
            TwitchAdRecovery {
                login: "channel".into(),
                selector: "video-group:chunked".into(),
                target_width: 1920,
                target_height: 1080,
                target_frame_rate_milli: 60_000,
            },
            client,
        ));
        let owner_recovery = recovery.clone();
        let owner =
            tokio::spawn(async move { owner_recovery.refresh_manifest(&HashMap::new()).await });
        tokio::time::timeout(std::time::Duration::from_secs(1), request_seen_rx)
            .await
            .expect("owner refresh should reach the mock proxy")
            .unwrap();

        let follower = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            recovery.refresh_manifest(&HashMap::new()),
        )
        .await
        .expect("follower must not wait for the in-flight network request");
        assert!(looks_like_hls_manifest(follower.body.as_bytes()));
        assert!(follower.body.contains("#EXT-X-GAP"));

        owner.abort();
        let _ = owner.await;
        assert!(!recovery.recovery_in_flight.load(Ordering::Acquire));
        proxy_server.abort();
    }

    #[test]
    fn probe_validation_rejects_login_pages_and_wrong_containers() {
        assert_eq!(
            validate_probe_sample(
                PlaybackProtocol::Hls,
                Some("application/vnd.apple.mpegurl"),
                b"#EXTM3U\n#EXT-X-VERSION:3\n"
            ),
            Ok(())
        );
        assert_eq!(
            validate_probe_sample(PlaybackProtocol::Flv, Some("video/x-flv"), b"FLV\x01"),
            Ok(())
        );
        assert_eq!(
            validate_probe_sample(
                PlaybackProtocol::Unknown,
                Some("text/html"),
                b"<!DOCTYPE html>"
            ),
            Err("html_response")
        );
        assert_eq!(
            validate_probe_sample(PlaybackProtocol::Hls, None, &[0x47, 0x40, 0, 0x10]),
            Err("invalid_hls")
        );
    }

    #[tokio::test]
    async fn media_relay_uses_configured_http_proxy_for_upstream_streams() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]);
            assert!(request.starts_with("GET http://twitch.invalid/live.ts HTTP/1.1"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 3\r\nConnection: close\r\n\r\nTS!",
                )
                .unwrap();
        });

        let relay = StreamProxy::new();
        let session_id = "proxy-test:1";
        let local_url = relay
            .start(
                "http://twitch.invalid/live.ts".into(),
                HashMap::new(),
                session_id.into(),
                false,
                Some(&format!("http://{address}")),
                None,
            )
            .await
            .unwrap();
        let local = Url::parse(&local_url).unwrap();
        let address = format!("{}:{}", local.host_str().unwrap(), local.port().unwrap());
        let mut local_stream = tokio::net::TcpStream::connect(address).await.unwrap();
        local_stream
            .write_all(b"GET /live HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        local_stream.read_to_end(&mut response).await.unwrap();

        let telemetry = relay.telemetry_for_session(session_id).unwrap();
        assert_eq!(telemetry.upstream_requests, 1);
        assert_eq!(telemetry.upstream_failures, 0);
        assert_eq!(telemetry.bytes_forwarded, 3);
        assert!(telemetry.first_response_ms.is_some());
        assert!(telemetry.latest_response_ms.is_some());
        // 多视图时钟对齐所依赖的媒体锚点，
        // 锁存自本会话第一个被转发的媒体字节。
        assert!(telemetry.first_media_at_ms.is_some_and(|epoch| epoch > 0));
        relay.stop_for_session(session_id);
        server.join().unwrap();
        assert!(String::from_utf8_lossy(&response).ends_with("\r\n\r\nTS!"));
    }

    #[tokio::test]
    async fn stopping_proxy_cancels_an_accepted_streaming_handler() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = listener.local_addr().unwrap();
        let (request_seen_tx, request_seen_rx) = oneshot::channel();
        let (connection_closed_tx, connection_closed_rx) = oneshot::channel();
        let upstream = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).await.unwrap();
            assert!(length > 0);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            let _ = request_seen_tx.send(());
            let mut byte = [0_u8; 1];
            let closed = matches!(stream.read(&mut byte).await, Ok(0));
            let _ = connection_closed_tx.send(closed);
        });

        let relay = StreamProxy::new();
        let session_id = "shutdown-test:1";
        let local_url = relay
            .start(
                format!("http://{upstream_address}/live.ts"),
                HashMap::new(),
                session_id.into(),
                false,
                None,
                None,
            )
            .await
            .unwrap();
        let local = Url::parse(&local_url).unwrap();
        let local_address = format!("{}:{}", local.host_str().unwrap(), local.port().unwrap());
        let mut local_stream = tokio::net::TcpStream::connect(local_address).await.unwrap();
        local_stream
            .write_all(b"GET /live HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), request_seen_rx)
            .await
            .expect("accepted handler should reach upstream")
            .unwrap();

        assert!(relay.stop_for_session(session_id));
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), connection_closed_rx)
                .await
                .expect("stop should cancel the accepted upstream request")
                .unwrap()
        );
        let mut downstream = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            local_stream.read_to_end(&mut downstream),
        )
        .await
        .expect("stop should close the downstream socket")
        .unwrap();
        upstream.await.unwrap();
    }

    #[tokio::test]
    async fn source_probe_uses_configured_proxy_without_exposing_source_secrets() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]);
            assert!(
                request
                    .starts_with("GET http://media.invalid/live.flv?token=probe-secret HTTP/1.1")
            );
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("cookie: session=private")
            );
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: video/x-flv\r\nContent-Length: 5\r\nConnection: close\r\n\r\nFLV\x01\x05",
                )
                .unwrap();
        });
        let mut headers = HashMap::new();
        headers.insert("cookie".into(), "session=private".into());

        let probes = probe_sources(
            vec![PlayUrl {
                source_id: "probe:1".into(),
                label: "测试线路".into(),
                protocol: PlaybackProtocol::Flv,
                priority: 0,
                url: "http://media.invalid/live.flv?token=probe-secret".into(),
                headers,
                twitch_ad_recovery: None,
            }],
            Some(&format!("http://{address}")),
        )
        .await
        .unwrap();

        server.join().unwrap();
        assert_eq!(probes.len(), 1);
        assert!(probes[0].available);
        assert_eq!(probes[0].source_id, "probe:1");
        assert_eq!(probes[0].sampled_bytes, 5);
        let serialized = serde_json::to_string(&probes).unwrap();
        assert!(!serialized.contains("media.invalid"));
        assert!(!serialized.contains("probe-secret"));
        assert!(!serialized.contains("session=private"));
    }
}

/// 流式传输刻意不设整体请求超时：健康的直播响应可以无限期保持打开。
/// 连接到该代理实例的所有客户端仍共享相同的传输层限制。
fn build_stream_client(proxy: Option<&str>) -> AppResult<Client> {
    crate::http_client::with_proxy(
        Client::builder()
            .use_native_tls()
            .connect_timeout(std::time::Duration::from_secs(10))
            .pool_max_idle_per_host(2)
            .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT),
        proxy,
    )?
    .build()
    .map_err(|_| AppError::new("stream_proxy_client", "媒体代理网络客户端初始化失败"))
}

fn build_probe_client(proxy: Option<&str>) -> AppResult<Client> {
    crate::http_client::with_proxy(
        Client::builder()
            .use_native_tls()
            .connect_timeout(Duration::from_secs(3))
            .timeout(PROBE_TIMEOUT)
            .pool_max_idle_per_host(4)
            .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT),
        proxy,
    )?
    .build()
    .map_err(|_| AppError::new("stream_proxy_probe_client", "线路探测网络客户端初始化失败"))
}

async fn run_proxy_loop(
    listener: TcpListener,
    context: ProxyLoopContext,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut handlers = JoinSet::new();
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            accept = listener.accept() => {
                match accept {
                    Ok((mut socket, _)) => {
                        let context = context.clone();
                        let telemetry = context.telemetry.clone();
                        let mut handler_shutdown = shutdown.clone();
                        handlers.spawn(async move {
                            tokio::select! {
                                _ = wait_for_proxy_shutdown(&mut handler_shutdown) => {}
                                result = handle_client(&mut socket, context) => {
                                    if let Err(e) = result {
                                        telemetry.upstream_failures.fetch_add(1, Ordering::Relaxed);
                                        tracing::debug!(%e, "stream proxy client ended");
                                    }
                                }
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!(%e, "stream proxy accept failed");
                        break;
                    }
                }
            }
            completed = handlers.join_next(), if !handlers.is_empty() => {
                if let Some(Err(error)) = completed
                    && !error.is_cancelled()
                {
                    tracing::debug!(%error, "stream proxy handler task failed");
                }
            }
        }
    }

    handlers.abort_all();
    while handlers.join_next().await.is_some() {}
}

async fn wait_for_proxy_shutdown(shutdown: &mut watch::Receiver<bool>) {
    if *shutdown.borrow() {
        return;
    }
    while shutdown.changed().await.is_ok() {
        if *shutdown.borrow() {
            return;
        }
    }
}

async fn handle_client(
    socket: &mut tokio::net::TcpStream,
    context: ProxyLoopContext,
) -> Result<(), String> {
    let ProxyLoopContext {
        client,
        url,
        headers,
        hls_resources,
        local_origin,
        force_hls,
        twitch_ad_recovery,
        telemetry,
    } = context;

    // 读取请求头（只需要方法/路径；GET 不使用 body）。
    let mut buf = [0u8; 4096];
    let n = socket
        .read(&mut buf)
        .await
        .map_err(|e| format!("read request: {e}"))?;
    if n == 0 {
        return Ok(());
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    let first = head.lines().next().unwrap_or("");
    let mut request_parts = first.split_whitespace();
    let method = request_parts.next().unwrap_or("");
    let request_target = request_parts.next().unwrap_or("");
    let is_primary_request = request_target
        .split_once('?')
        .map_or(request_target, |(path, _)| path)
        == "/live";

    if method == "OPTIONS" {
        let resp = concat!(
            "HTTP/1.1 204 No Content\r\n",
            "Access-Control-Allow-Origin: *\r\n",
            "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n",
            "Access-Control-Allow-Headers: *\r\n",
            "Connection: close\r\n\r\n"
        );
        socket
            .write_all(resp.as_bytes())
            .await
            .map_err(|e| format!("write options: {e}"))?;
        return Ok(());
    }
    if method != "GET" && method != "HEAD" {
        let resp = "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n";
        let _ = socket.write_all(resp.as_bytes()).await;
        return Ok(());
    }

    let renewed_primary = if is_primary_request {
        match twitch_ad_recovery.as_deref() {
            Some(recovery) => recovery.current_manifest_url().await,
            None => None,
        }
    } else {
        None
    };
    let target = match renewed_primary {
        Some(target) => target,
        None => {
            match resolve_upstream_target(request_target, url.as_ref(), hls_resources.as_ref()) {
                Ok(target) => target,
                Err(message) => {
                    write_text_response(socket, 404, "Not Found", message).await?;
                    return Ok(());
                }
            }
        }
    };

    let mut req = client.get(target);
    for (k, v) in headers.as_ref() {
        req = req.header(k.as_str(), v.as_str());
    }
    // 避免会让 MSE 解复用器困惑的压缩 body。
    req = req.header("accept-encoding", "identity");
    if let Some(range) = request_header(&head, "range") {
        req = req.header(reqwest::header::RANGE, range);
    }

    telemetry.upstream_requests.fetch_add(1, Ordering::Relaxed);
    let request_started = Instant::now();
    let upstream = req.send().await.map_err(|e| format!("upstream: {e}"))?;
    telemetry.record_response(request_started.elapsed());
    let status = upstream.status().as_u16();
    let status_reason = upstream.status().canonical_reason().unwrap_or("OK");
    let upstream_url = upstream.url().clone();
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let content_length = upstream
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let content_range = upstream
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    if method == "HEAD" {
        write_media_headers(
            socket,
            status,
            status_reason,
            &content_type,
            content_length.as_deref(),
            content_range.as_deref(),
            "no-cache",
        )
        .await?;
        return Ok(());
    }

    if !upstream.status().is_success() {
        let body = upstream.text().await.unwrap_or_default();
        telemetry.record_bytes(body.len());
        if is_primary_request
            && is_twitch_ad_manifest(&body)
            && let Some(recovery) = twitch_ad_recovery.as_deref()
            && let Some(replacement) = recovery
                .replace_ad_manifest(&body, &upstream_url, headers.as_ref())
                .await
        {
            write_hls_manifest(
                socket,
                200,
                "OK",
                &replacement.body,
                &replacement.upstream_url,
                local_origin.as_ref(),
                hls_resources.as_ref(),
            )
            .await?;
            return Ok(());
        }
        if is_primary_request && let Some(recovery) = twitch_ad_recovery.as_deref() {
            let replacement = recovery.refresh_manifest(headers.as_ref()).await;
            write_hls_manifest(
                socket,
                200,
                "OK",
                &replacement.body,
                &replacement.upstream_url,
                local_origin.as_ref(),
                hls_resources.as_ref(),
            )
            .await?;
            return Ok(());
        }
        let resp = format!(
            "HTTP/1.1 {status} Error\r\n\
             Content-Type: text/plain; charset=utf-8\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Connection: close\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(resp.as_bytes()).await;
        return Err(format!("upstream status {status}"));
    }

    if is_hls_manifest(&upstream_url, &content_type) {
        let mut manifest = upstream
            .text()
            .await
            .map_err(|e| format!("read hls manifest: {e}"))?;
        telemetry.record_bytes(manifest.len());
        let mut manifest_url = upstream_url;
        if is_primary_request
            && let Some(recovery) = twitch_ad_recovery.as_deref()
            && let Some(replacement) = recovery
                .replace_ad_manifest(&manifest, &manifest_url, headers.as_ref())
                .await
        {
            manifest = replacement.body;
            manifest_url = replacement.upstream_url;
        }
        if is_primary_request
            && (manifest.contains("#EXT-X-ENDLIST")
                || !looks_like_hls_manifest(manifest.as_bytes()))
            && let Some(recovery) = twitch_ad_recovery.as_deref()
        {
            let replacement = recovery.refresh_manifest(headers.as_ref()).await;
            manifest = replacement.body;
            manifest_url = replacement.upstream_url;
        }
        write_hls_manifest(
            socket,
            status,
            status_reason,
            &manifest,
            &manifest_url,
            local_origin.as_ref(),
            hls_resources.as_ref(),
        )
        .await?;
        return Ok(());
    }

    if force_hls {
        let mut stream = upstream.bytes_stream();
        let mut prefix = Vec::new();
        while prefix.len() < 1_024 {
            let Some(chunk) = stream.next().await else {
                break;
            };
            let chunk = chunk.map_err(|e| format!("upstream chunk: {e}"))?;
            telemetry.record_bytes(chunk.len());
            prefix.extend_from_slice(&chunk);
        }

        if looks_like_hls_manifest(&prefix) {
            const MAX_HLS_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("upstream chunk: {e}"))?;
                telemetry.record_bytes(chunk.len());
                if prefix.len().saturating_add(chunk.len()) > MAX_HLS_MANIFEST_BYTES {
                    write_text_response(
                        socket,
                        502,
                        "Bad Gateway",
                        "HLS manifest is unexpectedly large",
                    )
                    .await?;
                    return Err("HLS manifest exceeds size limit".into());
                }
                prefix.extend_from_slice(&chunk);
            }
            let manifest = String::from_utf8_lossy(&prefix);
            write_hls_manifest(
                socket,
                status,
                status_reason,
                &manifest,
                &upstream_url,
                local_origin.as_ref(),
                hls_resources.as_ref(),
            )
            .await?;
            return Ok(());
        }

        write_media_headers(
            socket,
            status,
            status_reason,
            &content_type,
            content_length.as_deref(),
            content_range.as_deref(),
            "no-store",
        )
        .await?;
        // 上面的探测已经拉到了最初的媒体字节，这就是流头部到达的纪元。
        telemetry.record_media_start();
        if !prefix.is_empty() && socket.write_all(&prefix).await.is_err() {
            return Ok(());
        }
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("upstream chunk: {e}"))?;
            telemetry.record_bytes(chunk.len());
            if !chunk.is_empty() && socket.write_all(&chunk).await.is_err() {
                break;
            }
        }
        let _ = socket.flush().await;
        return Ok(());
    }

    write_media_headers(
        socket,
        status,
        status_reason,
        &content_type,
        content_length.as_deref(),
        content_range.as_deref(),
        "no-store",
    )
    .await?;

    let mut stream = upstream.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("upstream chunk: {e}"))?;
        telemetry.record_bytes(chunk.len());
        if chunk.is_empty() {
            continue;
        }
        telemetry.record_media_start();
        if socket.write_all(&chunk).await.is_err() {
            break; // 客户端已离开
        }
    }
    let _ = socket.flush().await;
    Ok(())
}

fn resolve_upstream_target(
    request_target: &str,
    default_url: &str,
    hls_resources: &HlsResources,
) -> Result<String, &'static str> {
    let path = request_target
        .split_once('?')
        .map_or(request_target, |(path, _)| path);
    if path == "/live" {
        return Ok(default_url.to_string());
    }
    let Some(id) = path.strip_prefix("/hls/") else {
        return Err("unknown proxy path");
    };
    if id.is_empty() || id.contains('/') {
        return Err("invalid HLS resource path");
    }
    // 改写后的 URL 为 FFmpeg 保留了上游扩展名；
    // 注册表本身仍然只以数字 id 为键。
    let id = id.split_once('.').map_or(id, |(id, _)| id);
    let id = id
        .parse::<u64>()
        .map_err(|_| "invalid HLS resource identifier")?;
    hls_resources
        .resolve(id)
        .ok_or("HLS resource is no longer available")
}

fn request_header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(name)
            .then_some(value.trim())
            .filter(|value| !value.is_empty())
    })
}

async fn fetch_twitch_playlist(
    client: &Client,
    url: &str,
    headers: &HashMap<String, String>,
) -> Result<(String, Url), String> {
    let mut request = client.get(url);
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = request
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| "request failed".to_string())?;
    let status = response.status();
    let effective_url = response.url().clone();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let body = response
        .text()
        .await
        .map_err(|_| "read failed".to_string())?;
    Ok((body, effective_url))
}

/// 设为 `pub(crate)`，让 Twitch 直播冒烟测试用代理自带的同一个检测器判断
/// 播放列表，而不是用只会漏掉无文本广告段（本函数正是为此存在）的
/// 纯文本副本。
pub(crate) fn is_twitch_ad_manifest(manifest: &str) -> bool {
    let lower = manifest.to_ascii_lowercase();
    if lower.contains("commercial break in progress") {
        return true;
    }
    // Twitch 通过 `twitch-stream-source` DATERANGE 标注当前渲染档。干净的直播
    // 清单报告 `live`；服务端广告期间则改标广告来源。
    // 这能抓住上面两种文本标记都不带的广告时段。
    let current_source = manifest
        .lines()
        .filter(|line| line.trim_start().starts_with("#EXT-X-DATERANGE:"))
        .filter_map(|line| {
            let value = line.split("X-TV-TWITCH-STREAM-SOURCE=").nth(1)?;
            Some(value.trim_start_matches('"').split('"').next()?.to_string())
        })
        .next_back();
    if let Some(source) = current_source {
        return !source.eq_ignore_ascii_case("live");
    }
    manifest.lines().any(|line| {
        line.trim_start().starts_with("#EXT-X-DATERANGE:")
            && line.to_ascii_lowercase().contains("stitched")
    })
}

fn mark_twitch_ad_segments_as_gaps(manifest: &str) -> String {
    mark_hls_segments_as_gaps(manifest, false)
}

fn mark_all_hls_segments_as_gaps(manifest: &str) -> String {
    mark_hls_segments_as_gaps(manifest, true)
}

fn mark_hls_segments_as_gaps(manifest: &str, mark_all: bool) -> String {
    let mut output = Vec::new();
    for line in manifest.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("#EXT-X-TWITCH-PREFETCH:") {
            continue;
        }
        output.push(line.to_string());
        if trimmed.starts_with("#EXTINF")
            && (mark_all || !trimmed.to_ascii_lowercase().contains(",live"))
        {
            output.push("#EXT-X-GAP".into());
        }
    }
    let mut body = output.join("\n");
    if manifest.ends_with('\n') {
        body.push('\n');
    }
    body
}

/// 用于经回环预热录制代理的客户端。
///
/// 刻意不用中继自身的上游客户端：后者可能携带用户的 HTTP 代理，
/// 把 `127.0.0.1` 路由过去必然失败。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn build_loopback_client() -> AppResult<Client> {
    Client::builder()
        .no_proxy()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|_| AppError::new("stream_proxy_warmup_client", "本地清单预热客户端初始化失败"))
}

/// 判断某份 HLS 媒体清单是否至少提供一个解复用器真正可读的分片。
///
/// `#EXT-X-GAP` 声明其后的 URI 不含媒体，这正是 Twitch 的广告/等待路径产出的
/// 内容。仅由它组成的清单是合法 HLS，轮询式播放器可以扛过去，
/// 但 `avformat_open_input` 读一次占位符、一无所获，
/// 直接判定录制失败。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn manifest_has_playable_segment(manifest: &str) -> bool {
    if !looks_like_hls_manifest(manifest.as_bytes()) {
        return false;
    }
    let mut in_segment = false;
    let mut gapped = false;
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("#EXTINF") {
            in_segment = true;
            gapped = false;
            continue;
        }
        if trimmed.eq_ignore_ascii_case("#EXT-X-GAP") {
            gapped = true;
            continue;
        }
        if trimmed.starts_with('#') {
            continue;
        }
        if in_segment {
            if !gapped {
                return true;
            }
            in_segment = false;
            gapped = false;
        }
    }
    false
}

fn twitch_wait_manifest() -> String {
    let sequence = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 2;
    format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n#EXTINF:2.000,\n#EXT-X-GAP\ngap.ts\n"
    )
}

fn is_hls_manifest(url: &Url, content_type: &str) -> bool {
    let content_type = content_type.to_ascii_lowercase();
    url.path().to_ascii_lowercase().ends_with(".m3u8")
        || content_type.contains("application/vnd.apple.mpegurl")
        || content_type.contains("application/x-mpegurl")
        || content_type.contains("audio/mpegurl")
}

fn looks_like_hls_manifest(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).ok().is_some_and(|text| {
        text.trim_start_matches('\u{feff}')
            .trim_start()
            .starts_with("#EXTM3U")
    })
}

async fn write_hls_manifest(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    status_reason: &str,
    manifest: &str,
    upstream_url: &Url,
    local_origin: &str,
    hls_resources: &HlsResources,
) -> Result<(), String> {
    let manifest = rewrite_hls_manifest(manifest, upstream_url, local_origin, hls_resources);
    let body = manifest.as_bytes();
    let manifest_length = body.len().to_string();
    write_media_headers(
        socket,
        status,
        status_reason,
        "application/vnd.apple.mpegurl; charset=utf-8",
        Some(&manifest_length),
        None,
        "no-store",
    )
    .await?;
    socket
        .write_all(body)
        .await
        .map_err(|e| format!("write hls manifest: {e}"))?;
    let _ = socket.flush().await;
    Ok(())
}

fn rewrite_hls_manifest(
    manifest: &str,
    upstream_url: &Url,
    local_origin: &str,
    hls_resources: &HlsResources,
) -> String {
    let mut output = manifest
        .lines()
        .map(|line| {
            if line.trim_start().starts_with('#') {
                rewrite_hls_tag_uris(line, upstream_url, local_origin, hls_resources)
            } else {
                rewrite_hls_uri_line(line, upstream_url, local_origin, hls_resources)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if manifest.ends_with('\n') {
        output.push('\n');
    }
    output
}

fn rewrite_hls_uri_line(
    line: &str,
    upstream_url: &Url,
    local_origin: &str,
    hls_resources: &HlsResources,
) -> String {
    let candidate = line.trim();
    if candidate.is_empty() {
        return line.to_string();
    }
    let leading_len = line.len() - line.trim_start().len();
    let trailing_len = line.len() - line.trim_end().len();
    let prefix = &line[..leading_len];
    let suffix = &line[line.len() - trailing_len..];
    match hls_local_url(candidate, upstream_url, local_origin, hls_resources) {
        Some(local) => format!("{prefix}{local}{suffix}"),
        None => line.to_string(),
    }
}

fn rewrite_hls_tag_uris(
    line: &str,
    upstream_url: &Url,
    local_origin: &str,
    hls_resources: &HlsResources,
) -> String {
    let mut output = String::with_capacity(line.len());
    let mut remainder = line;
    while let Some(uri_start) = remainder.find("URI=\"") {
        let value_start = uri_start + "URI=\"".len();
        let Some(value_end) = remainder[value_start..].find('"') else {
            output.push_str(remainder);
            return output;
        };
        let value_end = value_start + value_end;
        output.push_str(&remainder[..value_start]);
        let original = &remainder[value_start..value_end];
        output.push_str(
            &hls_local_url(original, upstream_url, local_origin, hls_resources)
                .unwrap_or_else(|| original.to_string()),
        );
        remainder = &remainder[value_end..];
    }
    output.push_str(remainder);
    output
}

fn hls_local_url(
    raw_url: &str,
    upstream_url: &Url,
    local_origin: &str,
    hls_resources: &HlsResources,
) -> Option<String> {
    let resolved = upstream_url.join(raw_url).ok()?;
    if !matches!(resolved.scheme(), "http" | "https") {
        return None;
    }
    let id = hls_resources.register(resolved.to_string());
    // FFmpeg 的 HLS 解复用器只打开扩展名在其白名单内的分片 URL，而自 FFmpeg 8 起
    // `extension_picky` 把这变成了默认行为。无扩展名的 `/hls/{id}` 在浏览器中播放
    // 正常，却会让 `avformat_open_input` 以
    // `Invalid data found when processing input` 失败，
    // 在录制写入一个字节之前就将其杀死。继承上游扩展名
    // 可以让改写后的 URL 对浏览器和 FFmpeg 都保持可识别。
    Some(match hls_path_extension(&resolved) {
        Some(extension) => format!("{local_origin}/hls/{id}.{extension}"),
        None => format!("{local_origin}/hls/{id}"),
    })
}

/// 上游路径的文件扩展名（仅当它较短且为字母数字时）。
///
/// 只从路径读取。Twitch 分片 URL 以 `.mp4?dna=<token>` 结尾，
/// 该 token 和任何其他 query 内容都不得泄漏进本地路径。
/// 扩展名异常或缺失时返回 `None`，改写后的 URL 保持无扩展名，
/// 而不是编造一个。
fn hls_path_extension(url: &Url) -> Option<String> {
    let last = url.path_segments()?.next_back()?;
    let extension = last.rsplit_once('.')?.1;
    (!extension.is_empty()
        && extension.len() <= 5
        && extension.chars().all(|value| value.is_ascii_alphanumeric()))
    .then(|| extension.to_ascii_lowercase())
}

async fn write_text_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\
         Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket
        .write_all(response.as_bytes())
        .await
        .map_err(|e| format!("write text response: {e}"))
}

async fn write_media_headers(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    content_length: Option<&str>,
    content_range: Option<&str>,
    cache_control: &str,
) -> Result<(), String> {
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Cache-Control: {cache_control}\r\n\
         Connection: close\r\n"
    );
    if let Some(content_length) = content_length {
        response.push_str(&format!("Content-Length: {content_length}\r\n"));
    }
    if let Some(content_range) = content_range {
        response.push_str(&format!("Content-Range: {content_range}\r\n"));
    }
    response.push_str("Accept-Ranges: bytes\r\n\r\n");
    socket
        .write_all(response.as_bytes())
        .await
        .map_err(|e| format!("write media header: {e}"))
}
