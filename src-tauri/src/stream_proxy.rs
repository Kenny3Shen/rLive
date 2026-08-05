//! Localhost HTTP proxy that injects CDN headers for WebView media playback.
//!
//! Browser `<video>` / MSE cannot attach Bilibili `Referer` / `User-Agent` to
//! media requests. This proxy binds `127.0.0.1:0`, forwards the live URL with
//! the required headers, and returns a same-origin-friendly stream URL for
//! xgplayer protocol plugins — no mpv HWND.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::error::{AppError, AppResult};
use crate::models::live::{PlayUrl, PlaybackProtocol};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROBE_SOURCES: usize = 12;
const MAX_PROBE_SAMPLE_BYTES: usize = 64 * 1024;

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

/// Probe playback candidates through the same configured upstream proxy used
/// by the real relay. Results are returned in input order and contain no URL,
/// Cookie, Referer, redirect target, or transport error text.
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
    let source_id = if source.source_id.trim().is_empty() {
        format!("source:{}", index + 1)
    } else {
        source.source_id.clone()
    };
    let mut result = StreamProxyProbe {
        source_id,
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

/// Active proxy endpoint (one per app — single-room desktop client).
pub struct StreamProxy {
    state: Mutex<ProxyState>,
    /// Last bound port (0 = none). Exposed for diagnostics.
    port: AtomicU16,
}

/// All lifecycle mutations share one short, synchronous critical section.
///
/// Binding a TCP listener is asynchronous, so an active proxy alone is not
/// enough to describe the lifecycle: while a new listener is being created we
/// also need to remember which playback session is allowed to install it.
/// Otherwise two overlapping `start` commands can each bind a listener and
/// the later assignment can orphan the former task.
struct ProxyState {
    inner: Option<ProxyInner>,
    pending: Option<PendingProxy>,
    generation: u64,
}

impl Default for ProxyState {
    fn default() -> Self {
        Self {
            inner: None,
            pending: None,
            generation: 0,
        }
    }
}

struct PendingProxy {
    generation: u64,
    session_id: String,
}

struct ProxyInner {
    /// The frontend playback generation that owns this listener.  A stale
    /// room cleanup must never be able to stop a newer room's proxy.
    session_id: String,
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
        }
    }

    fn record_response(&self, elapsed: Duration) {
        let millis = elapsed.as_millis().min(u64::MAX as u128) as u64;
        self.latest_response_ms.store(millis, Ordering::Relaxed);
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
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

/// The proxy rewrites HLS manifests to this localhost listener.  Only URLs
/// found in a manifest are placed in the registry, so the loopback server
/// cannot become a generic browser-accessible request proxy.
struct HlsResources {
    next_id: AtomicU64,
    max_entries: usize,
    entries: Mutex<HlsResourceEntries>,
}

struct HlsResourceEntries {
    by_id: HashMap<u64, String>,
    by_url: HashMap<String, u64>,
    /// Least-recently used resource identifier at the front.  The selected
    /// HLS child playlist is requested for every playlist refresh, whereas
    /// individual media segments are normally requested once.  Treating this
    /// as an access queue keeps that long-lived playlist mapping alive.
    access_order: VecDeque<u64>,
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
            if let Some(expired) = entries.access_order.pop_front() {
                if let Some(expired_url) = entries.by_id.remove(&expired) {
                    if entries.by_url.get(&expired_url) == Some(&expired) {
                        entries.by_url.remove(&expired_url);
                    }
                }
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
            port: AtomicU16::new(0),
        }
    }
}

impl StreamProxy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        // A global stop is used only during application shutdown.  Invalidate
        // a listener currently being bound as well as an already-active one.
        Self::advance_generation(&mut state);
        state.pending = None;
        Self::stop_active(&mut state);
        self.port.store(0, Ordering::Release);
    }

    /// Stop only when the caller still owns the active listener.
    ///
    /// Route unmount cleanup is asynchronous.  Without this ownership check,
    /// an old room can finish its `stream_proxy_stop` command after a fast
    /// re-entry has already started a fresh proxy, producing a black player.
    pub fn stop_for_session(&self, session_id: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let owns_active_proxy = state
            .inner
            .as_ref()
            .is_some_and(|inner| inner.session_id == session_id);
        let owns_pending_proxy = state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.session_id == session_id);

        if !owns_active_proxy && !owns_pending_proxy {
            return false;
        }

        // The matching session may still be awaiting TcpListener::bind.  Its
        // completion checks this generation before it can install a task.
        Self::advance_generation(&mut state);
        if owns_pending_proxy {
            state.pending = None;
        }
        if owns_active_proxy {
            Self::stop_active(&mut state);
            self.port.store(0, Ordering::Release);
        }
        true
    }

    /// Return only aggregate counters for the active owner. URLs and request
    /// headers are intentionally absent from the diagnostics contract.
    pub fn telemetry_for_session(&self, session_id: &str) -> Option<StreamProxyTelemetry> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state
            .inner
            .as_ref()
            .filter(|inner| inner.session_id == session_id)
            .map(|inner| inner.telemetry.snapshot())
    }

    /// Start (or replace) a proxy for `url` with `headers`. Returns local play URL.
    pub async fn start(
        &self,
        url: String,
        headers: HashMap<String, String>,
        session_id: String,
        force_hls: bool,
        proxy: Option<&str>,
    ) -> AppResult<String> {
        // Reserve ownership before the first await.  A later start or a stop
        // can supersede this reservation, in which case this request drops
        // its uninstalled listener instead of overwriting a newer task.
        let generation = self.reserve_start(&session_id);

        // Every proxy gets an ephemeral port, so there is no need to wait for
        // a previous socket's port to become reusable.  Avoiding that sleep is
        // also important: it used to widen the enter/exit/re-enter race.
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(e) => {
                self.clear_pending(generation);
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
                self.clear_pending(generation);
                AppError::new("stream_proxy_bind", e.to_string())
            })?
            .port();
        // MSE protocol plugins can issue several localhost requests for one live stream.
        // Build one client per proxy lifetime so those requests share its
        // connection pool instead of rebuilding TLS/pool state per request.
        let client = match build_stream_client(proxy) {
            Ok(client) => client,
            Err(error) => {
                self.clear_pending(generation);
                return Err(error);
            }
        };

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let is_current = state.pending.as_ref().is_some_and(|pending| {
            pending.generation == generation && pending.session_id == session_id
        });
        if !is_current {
            // `listener` has never been spawned, so dropping it is enough to
            // release the socket.  Do not touch a newer reservation/task.
            return Err(AppError::new(
                "stream_proxy_superseded",
                "playback session was replaced before proxy startup finished",
            )
            .retryable());
        }

        let hls_resources = Arc::new(HlsResources::new());
        let telemetry = Arc::new(ProxyTelemetryCounters::new());
        let local_origin = Arc::<str>::from(format!("http://127.0.0.1:{port}"));
        let task_telemetry = telemetry.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_proxy_loop(
                listener,
                client,
                Arc::<str>::from(url),
                Arc::new(headers),
                hls_resources,
                local_origin,
                force_hls,
                task_telemetry,
                shutdown_rx,
            )
            .await;
        });
        // Keep the old listener alive until its replacement is completely
        // bound and configured. This makes same-protocol soft switching
        // transactional up to the xgplayer switchURL call.
        Self::stop_active(&mut state);
        state.pending = None;
        state.inner = Some(ProxyInner {
            session_id,
            shutdown: shutdown_tx,
            task,
            telemetry,
        });
        self.port.store(port, Ordering::Release);
        Ok(format!("http://127.0.0.1:{port}/live"))
    }

    /// Reserve the next generation for `session_id`. The active listener stays
    /// usable until the replacement has bound and built its network client.
    fn reserve_start(&self, session_id: &str) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let generation = Self::advance_generation(&mut state);
        state.pending = Some(PendingProxy {
            generation,
            session_id: session_id.to_string(),
        });
        generation
    }

    fn clear_pending(&self, generation: u64) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.generation == generation)
        {
            state.pending = None;
        }
    }

    fn advance_generation(state: &mut ProxyState) -> u64 {
        state.generation = state.generation.wrapping_add(1);
        // `0` is not special today, but keeping generated values nonzero makes
        // future diagnostics and optional IDs less surprising after wrapping.
        if state.generation == 0 {
            state.generation = 1;
        }
        state.generation
    }

    fn stop_active(state: &mut ProxyState) {
        if let Some(inner) = state.inner.take() {
            let _ = inner.shutdown.send(true);
            inner.task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    use reqwest::Url;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{
        HlsResources, ProxyInner, ProxyTelemetryCounters, StreamProxy, looks_like_hls_manifest,
        probe_sources, rewrite_hls_manifest, validate_probe_sample,
    };
    use crate::models::live::{PlayUrl, PlaybackProtocol};
    use tokio::sync::watch;

    #[test]
    fn stale_session_cannot_stop_a_newer_proxy() {
        let proxy = StreamProxy::new();
        let (shutdown, _) = watch::channel(false);
        let task = tauri::async_runtime::spawn(async {
            std::future::pending::<()>().await;
        });
        {
            let mut state = proxy.state.lock().unwrap_or_else(|p| p.into_inner());
            state.inner = Some(ProxyInner {
                session_id: "new-room:2".to_string(),
                shutdown,
                task,
                telemetry: Arc::new(ProxyTelemetryCounters::new()),
            });
        }

        assert!(!proxy.stop_for_session("old-room:1"));
        assert!(
            proxy
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .inner
                .is_some()
        );
        assert!(proxy.stop_for_session("new-room:2"));
        assert!(proxy.telemetry_for_session("new-room:2").is_none());
        assert!(
            proxy
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .inner
                .is_none()
        );
    }

    #[test]
    fn newer_start_reservation_supersedes_an_uninstalled_proxy() {
        let proxy = StreamProxy::new();
        let first = proxy.reserve_start("room-a:1");
        let second = proxy.reserve_start("room-b:2");

        let state = proxy.state.lock().unwrap_or_else(|p| p.into_inner());
        assert_ne!(first, second);
        assert!(
            state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.generation == second)
        );
        assert!(
            state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.session_id == "room-b:2")
        );
    }

    #[test]
    fn matching_stop_cancels_a_pending_start() {
        let proxy = StreamProxy::new();
        let generation = proxy.reserve_start("room-a:1");

        assert!(proxy.stop_for_session("room-a:1"));
        let state = proxy.state.lock().unwrap_or_else(|p| p.into_inner());
        assert!(state.pending.is_none());
        assert_ne!(state.generation, generation);
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
            state.inner = Some(ProxyInner {
                session_id: "room-a:1".into(),
                shutdown,
                task,
                telemetry: Arc::new(ProxyTelemetryCounters::new()),
            });
        }

        proxy.reserve_start("room-a:1");

        assert!(
            proxy
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .inner
                .is_some()
        );
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

        assert!(rewritten.contains("URI=\"http://127.0.0.1:41500/hls/1\""));
        assert!(rewritten.contains("http://127.0.0.1:41500/hls/2"));
        assert!(rewritten.contains("http://127.0.0.1:41500/hls/3"));
        assert_eq!(
            resources.resolve(2).as_deref(),
            Some("https://media.example.test/live/variant/720p.m3u8")
        );
    }

    #[test]
    fn hls_resource_registry_keeps_a_refreshed_child_playlist_alive() {
        // A player asks for its selected child playlist on every reload, while
        // segment URLs continuously enter the bounded registry.  The playlist
        // must be promoted on access rather than eventually becoming a 404.
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
        relay.stop_for_session(session_id);
        server.join().unwrap();
        assert!(String::from_utf8_lossy(&response).ends_with("\r\n\r\nTS!"));
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

/// Streaming deliberately has no overall request timeout: a healthy live
/// response may remain open indefinitely.  It still shares the same transport
/// limits for every client connected to this proxy instance.
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
    client: Client,
    url: Arc<str>,
    headers: Arc<HashMap<String, String>>,
    hls_resources: Arc<HlsResources>,
    local_origin: Arc<str>,
    force_hls: bool,
    telemetry: Arc<ProxyTelemetryCounters>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    break;
                }
            }
            accept = listener.accept() => {
                match accept {
                    Ok((mut socket, _)) => {
                        let client = client.clone();
                        let url = url.clone();
                        let headers = headers.clone();
                        let hls_resources = hls_resources.clone();
                        let local_origin = local_origin.clone();
                        let telemetry = telemetry.clone();
                        let force_hls = force_hls;
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = handle_client(
                                &mut socket,
                                &client,
                                url.as_ref(),
                                headers.as_ref(),
                                hls_resources.as_ref(),
                                local_origin.as_ref(),
                                force_hls,
                                telemetry.as_ref(),
                            )
                            .await
                            {
                                telemetry.upstream_failures.fetch_add(1, Ordering::Relaxed);
                                tracing::debug!(%e, "stream proxy client ended");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!(%e, "stream proxy accept failed");
                        break;
                    }
                }
            }
        }
    }
}

async fn handle_client(
    socket: &mut tokio::net::TcpStream,
    client: &Client,
    url: &str,
    headers: &HashMap<String, String>,
    hls_resources: &HlsResources,
    local_origin: &str,
    force_hls: bool,
    telemetry: &ProxyTelemetryCounters,
) -> Result<(), String> {
    // Read request head (we only need method/path; body unused for GET).
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

    let target = match resolve_upstream_target(request_target, url, hls_resources) {
        Ok(target) => target,
        Err(message) => {
            write_text_response(socket, 404, "Not Found", message).await?;
            return Ok(());
        }
    };

    let mut req = client.get(target);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    // Avoid compressed bodies that confuse MSE demuxers.
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
        let manifest = upstream
            .text()
            .await
            .map_err(|e| format!("read hls manifest: {e}"))?;
        telemetry.record_bytes(manifest.len());
        write_hls_manifest(
            socket,
            status,
            status_reason,
            &manifest,
            &upstream_url,
            local_origin,
            hls_resources,
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
                local_origin,
                hls_resources,
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
        if socket.write_all(&chunk).await.is_err() {
            break; // client gone
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
    Some(format!("{local_origin}/hls/{id}"))
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
