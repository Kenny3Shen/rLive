//! 斗鱼 HTTP-FLV 续流。
//!
//! 斗鱼签名地址到期时 CDN 以正常 EOF 关闭上游连接。直接把 EOF 传给浏览器会
//! 让 mpegts.js 结束 MediaSource；这里保持同一个本机 HTTP 响应，在同一站点、
//! 画质和 CDN 上重新签名后继续写 FLV tag。

use std::collections::HashMap;
#[cfg(test)]
use std::collections::VecDeque;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::Client;
use tokio::io::AsyncWriteExt;

use super::{ProxyTelemetryCounters, write_media_headers};
use crate::error::AppResult;
use crate::models::live::DouyuFlvRecovery;

/// 正常签名寿命约 300 秒。短于该阈值的连接更可能是 CDN 故障或地址被拒，
/// 继续刷新只会形成重试风暴。
const DEFAULT_MIN_CONTINUATION: Duration = Duration::from_secs(30);
/// 合法斗鱼直播 tag 远小于该值；超过说明流损坏，不能继续累积内存。
const MAX_TAG_BYTES: usize = 8 * 1024 * 1024;
const FLV_HEADER_BYTES: usize = 9;
const FLV_PREVIOUS_TAG_BYTES: usize = 4;
const FLV_TAG_HEADER_BYTES: usize = 11;
const FLV_TAG_AUDIO: u8 = 8;
const FLV_TAG_VIDEO: u8 = 9;
const FLV_TAG_SCRIPT: u8 = 18;

/// 斗鱼 FLV 续流上下文。
///
/// 站点客户端已携带创建播放会话时的 Cookie 与代理路由；上下文只保留重新签名
/// 所需的房间、实际画质与 CDN，不把 Cookie 或签名 URL 暴露给 WebView。
#[derive(Clone)]
pub struct RecoveryContext {
    client: Client,
    headers: Arc<HashMap<String, String>>,
    refresh: RefreshSource,
}

#[derive(Clone)]
enum RefreshSource {
    Douyu {
        site: Arc<crate::sites::douyu::DouyuSite>,
        recovery: DouyuFlvRecovery,
    },
    #[cfg(test)]
    FixedUrls(Arc<Mutex<VecDeque<String>>>),
}

impl RecoveryContext {
    pub fn new(
        site: crate::sites::douyu::DouyuSite,
        client: Client,
        headers: HashMap<String, String>,
        recovery: DouyuFlvRecovery,
    ) -> Self {
        Self {
            client,
            headers: Arc::new(headers),
            refresh: RefreshSource::Douyu {
                site: Arc::new(site),
                recovery,
            },
        }
    }

    #[cfg(test)]
    fn for_test(
        client: Client,
        headers: HashMap<String, String>,
        refresh_urls: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            client,
            headers: Arc::new(headers),
            refresh: RefreshSource::FixedUrls(Arc::new(Mutex::new(
                refresh_urls.into_iter().collect(),
            ))),
        }
    }

    async fn refresh_url(&self) -> AppResult<String> {
        match &self.refresh {
            RefreshSource::Douyu { site, recovery } => site.refresh_play_url(recovery).await,
            #[cfg(test)]
            RefreshSource::FixedUrls(urls) => urls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front()
                .ok_or_else(|| {
                    crate::error::AppError::new(
                        "douyu_flv_test_refresh_exhausted",
                        "测试刷新地址已耗尽",
                    )
                }),
        }
    }
}

/// 保持一个关闭定界的浏览器响应，在上游正常 EOF 后续接新签名地址。
pub(super) async fn proxy(
    socket: &mut tokio::net::TcpStream,
    upstream: reqwest::Response,
    recovery: RecoveryContext,
    telemetry: Arc<ProxyTelemetryCounters>,
    connected_at: Instant,
) -> Result<(), String> {
    proxy_with_min_continuation(
        socket,
        upstream,
        recovery,
        telemetry,
        connected_at,
        DEFAULT_MIN_CONTINUATION,
    )
    .await
}

async fn proxy_with_min_continuation(
    socket: &mut tokio::net::TcpStream,
    upstream: reqwest::Response,
    recovery: RecoveryContext,
    telemetry: Arc<ProxyTelemetryCounters>,
    mut connected_at: Instant,
    min_continuation: Duration,
) -> Result<(), String> {
    // 连续响应没有总长度，使用 HTTP/1.1 的关闭定界（Connection: close）。
    // 绝不能写上游 Content-Length，否则续接字节会超出声明长度。
    write_media_headers(socket, 200, "OK", "video/x-flv", None, None, "no-store").await?;

    let mut relay = Relay::default();
    let mut current = Some(upstream);
    let mut first_connection = true;

    loop {
        let Some(upstream) = current.take() else {
            break;
        };
        let mut stream = upstream.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("upstream chunk: {e}"))?;
            telemetry.record_bytes(chunk.len());
            if chunk.is_empty() {
                continue;
            }
            telemetry.record_media_start();
            let output = relay.push(&chunk, first_connection)?;
            if !output.is_empty() && socket.write_all(&output).await.is_err() {
                return Ok(());
            }
        }

        if connected_at.elapsed() < min_continuation {
            break;
        }
        let Some(next_url) = refresh_url(&recovery).await else {
            break;
        };
        telemetry.upstream_requests.fetch_add(1, Ordering::Relaxed);
        let request_started = Instant::now();
        let Some(next) = open_upstream(&recovery, &next_url).await else {
            telemetry.upstream_failures.fetch_add(1, Ordering::Relaxed);
            break;
        };
        telemetry.record_response(request_started.elapsed());
        relay.begin_connection();
        first_connection = false;
        current = Some(next);
        connected_at = request_started;
    }

    let _ = socket.flush().await;
    let _ = socket.shutdown().await;
    Ok(())
}

async fn refresh_url(recovery: &RecoveryContext) -> Option<String> {
    match tokio::time::timeout(Duration::from_secs(8), refresh_url_from(recovery)).await {
        Ok(Ok(url)) => Some(url),
        Ok(Err(error)) => {
            tracing::warn!(code = %error.code, "斗鱼 FLV 续期失败");
            None
        }
        Err(_) => {
            tracing::warn!("斗鱼 FLV 续期超时");
            None
        }
    }
}

async fn refresh_url_from(recovery: &RecoveryContext) -> AppResult<String> {
    recovery.refresh_url().await
}

async fn open_upstream(recovery: &RecoveryContext, url: &str) -> Option<reqwest::Response> {
    let mut request = recovery.client.get(url);
    for (name, value) in recovery.headers.iter() {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = request
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        tracing::warn!(
            status = response.status().as_u16(),
            "斗鱼 FLV 续期地址不可用"
        );
        return None;
    }
    Some(response)
}

#[derive(Default)]
struct Relay {
    pending: Vec<u8>,
    header_seen: bool,
    metadata_seen: bool,
    audio_sequence_seen: bool,
    video_sequence_seen: bool,
    audio_config: Option<Vec<u8>>,
    video_config: Option<Vec<u8>>,
    last_audio_dts: Option<i64>,
    last_video_dts: Option<i64>,
}

impl Relay {
    fn begin_connection(&mut self) {
        // 每连接都是一条新的 FLV 字节流。丢弃上一连接可能留下的半 tag，
        // 但保留跨连接必须一致的编解码配置与时间戳状态。
        self.pending.clear();
        self.header_seen = false;
    }

    fn push(&mut self, bytes: &[u8], first_connection: bool) -> Result<Vec<u8>, String> {
        self.pending.extend_from_slice(bytes);
        if !self.header_seen {
            if self.pending.len() < FLV_HEADER_BYTES + FLV_PREVIOUS_TAG_BYTES {
                return Ok(Vec::new());
            }
            if &self.pending[..3] != b"FLV" {
                return Err("斗鱼 FLV 响应缺少文件头".into());
            }
            let data_offset = u32::from_be_bytes([
                self.pending[5],
                self.pending[6],
                self.pending[7],
                self.pending[8],
            ]) as usize;
            if data_offset < FLV_HEADER_BYTES || data_offset > 1_024 {
                return Err("斗鱼 FLV 文件头偏移无效".into());
            }
            if self.pending.len() < data_offset + FLV_PREVIOUS_TAG_BYTES {
                return Ok(Vec::new());
            }
            let header = self.pending.drain(..data_offset).collect::<Vec<_>>();
            let initial_previous = self
                .pending
                .drain(..FLV_PREVIOUS_TAG_BYTES)
                .collect::<Vec<_>>();
            self.header_seen = true;
            if first_connection {
                let mut output = header;
                output.extend_from_slice(&initial_previous);
                output.extend(self.push_tags(first_connection)?);
                return Ok(output);
            }
        }
        self.push_tags(first_connection)
    }

    fn push_tags(&mut self, first_connection: bool) -> Result<Vec<u8>, String> {
        let mut output = Vec::new();
        loop {
            if self.pending.len() < FLV_TAG_HEADER_BYTES {
                break;
            }
            let data_size = ((self.pending[1] as usize) << 16)
                | ((self.pending[2] as usize) << 8)
                | self.pending[3] as usize;
            if data_size > MAX_TAG_BYTES {
                return Err("斗鱼 FLV tag 超出长度上限".into());
            }
            let total = FLV_TAG_HEADER_BYTES + data_size;
            if self.pending.len() < total + FLV_PREVIOUS_TAG_BYTES {
                break;
            }
            let previous_size = u32::from_be_bytes([
                self.pending[total],
                self.pending[total + 1],
                self.pending[total + 2],
                self.pending[total + 3],
            ]) as usize;
            if previous_size != total {
                return Err("斗鱼 FLV PreviousTagSize 不匹配".into());
            }
            let tag = self
                .pending
                .drain(..total + FLV_PREVIOUS_TAG_BYTES)
                .collect::<Vec<_>>();
            let tag_type = tag[0] & 0x1f;
            let timestamp_lo = ((tag[4] as i64) << 16) | ((tag[5] as i64) << 8) | tag[6] as i64;
            let timestamp = timestamp_lo | ((tag[7] as i64) << 24);
            let data = &tag[FLV_TAG_HEADER_BYTES..total];
            if tag_type == FLV_TAG_SCRIPT {
                if first_connection && !self.metadata_seen {
                    self.metadata_seen = true;
                    output.extend_from_slice(&tag);
                }
                continue;
            }
            if tag_type == FLV_TAG_AUDIO {
                if is_audio_sequence_header(data) {
                    if !self.audio_sequence_seen {
                        self.audio_sequence_seen = true;
                        self.audio_config = Some(data.to_vec());
                        if first_connection {
                            output.extend_from_slice(&tag);
                        }
                    } else if self.audio_config.as_deref() != Some(data) {
                        return Err("斗鱼 FLV 续接的音频配置发生变化".into());
                    }
                    continue;
                }
                if self.last_audio_dts.is_some_and(|last| timestamp <= last) {
                    if !first_connection
                        && self
                            .last_audio_dts
                            .is_some_and(|last| last - timestamp > 10_000)
                    {
                        return Err("斗鱼 FLV 续接的音频时间轴回退".into());
                    }
                    continue;
                }
                self.last_audio_dts = Some(timestamp);
                output.extend_from_slice(&tag);
                continue;
            }
            if tag_type == FLV_TAG_VIDEO {
                if is_video_sequence_header(data) {
                    if !self.video_sequence_seen {
                        self.video_sequence_seen = true;
                        self.video_config = Some(data.to_vec());
                        if first_connection {
                            output.extend_from_slice(&tag);
                        }
                    } else if self.video_config.as_deref() != Some(data) {
                        return Err("斗鱼 FLV 续接的视频配置发生变化".into());
                    }
                    continue;
                }
                if self.last_video_dts.is_some_and(|last| timestamp <= last) {
                    if !first_connection
                        && self
                            .last_video_dts
                            .is_some_and(|last| last - timestamp > 10_000)
                    {
                        return Err("斗鱼 FLV 续接的视频时间轴回退".into());
                    }
                    continue;
                }
                self.last_video_dts = Some(timestamp);
                output.extend_from_slice(&tag);
                continue;
            }
        }
        Ok(output)
    }
}

fn is_audio_sequence_header(data: &[u8]) -> bool {
    data.len() >= 2 && data[0] >> 4 == 10 && data[1] == 0
}

fn is_video_sequence_header(data: &[u8]) -> bool {
    data.len() >= 2 && matches!(data[0] & 0x0f, 7 | 12) && data[1] == 0
}

/// 斗鱼在部分 CDN 上把 FLV 标成 `application/octet-stream`，因此 URL 扩展名
/// 可作为缺省信号；但上游一旦给出明确的非 FLV 类型，就不应把它交给 FLV 解析器。
pub(super) fn is_flv_response(content_type: &str, url: &str) -> bool {
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !content_type.is_empty() && content_type != "application/octet-stream" {
        return content_type.contains("flv");
    }
    reqwest::Url::parse(url)
        .ok()
        .is_some_and(|url| url.path().to_ascii_lowercase().ends_with(".flv"))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::{FLV_TAG_AUDIO, FLV_TAG_SCRIPT, FLV_TAG_VIDEO, Relay, proxy_with_min_continuation};
    use crate::stream_proxy::ProxyTelemetryCounters;

    fn tag(tag_type: u8, timestamp: i64, data: &[u8]) -> Vec<u8> {
        let mut tag = vec![tag_type, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let length = (data.len() as u32).to_be_bytes();
        tag[1..4].copy_from_slice(&length[1..]);
        let timestamp = (timestamp as u32).to_be_bytes();
        tag[4..7].copy_from_slice(&timestamp[1..]);
        tag[7] = timestamp[0];
        tag.extend_from_slice(data);
        tag.extend_from_slice(&(11_u32 + data.len() as u32).to_be_bytes());
        tag
    }

    fn stream(tags: &[Vec<u8>]) -> Vec<u8> {
        let mut stream = b"FLV\x01\x01\0\0\0\x09\0\0\0\0".to_vec();
        for tag in tags {
            stream.extend_from_slice(tag);
        }
        stream
    }

    struct Upstream {
        address: std::net::SocketAddr,
        task: tokio::task::JoinHandle<()>,
        requests: tokio::sync::mpsc::UnboundedReceiver<String>,
    }

    impl Drop for Upstream {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn upstream_with_body(first: Vec<u8>) -> Upstream {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests_tx, requests) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut head = Vec::new();
            let mut byte = [0_u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                    break;
                }
                head.push(byte[0]);
            }
            let _ = requests_tx.send(String::from_utf8_lossy(&head).into_owned());
            let _ = stream.write_all(&header(first.len())).await;
            let _ = stream.write_all(&first).await;
            let _ = stream.shutdown().await;
        });
        Upstream {
            address,
            task,
            requests,
        }
    }

    async fn follow_up_upstream(answer: Vec<u8>) -> Upstream {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests_tx, requests) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut head = Vec::new();
            let mut byte = [0_u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                    break;
                }
                head.push(byte[0]);
            }
            let _ = requests_tx.send(String::from_utf8_lossy(&head).into_owned());
            let _ = stream.write_all(&header(answer.len())).await;
            let _ = stream.write_all(&answer).await;
            let _ = stream.shutdown().await;
        });
        Upstream {
            address,
            task,
            requests,
        }
    }

    fn header(length: usize) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    async fn response(url: &str) -> reqwest::Response {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap()
    }

    fn test_context(second_url: String) -> super::RecoveryContext {
        super::RecoveryContext::for_test(
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            HashMap::new(),
            [second_url],
        )
    }

    #[tokio::test]
    async fn continuation_uses_second_upstream_in_same_downstream_response() {
        let first_body = stream(&[
            tag(FLV_TAG_SCRIPT, 0, b"metadata"),
            tag(FLV_TAG_AUDIO, 12, b"\xaf\x00\x12\x10"),
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config"),
            tag(FLV_TAG_AUDIO, 10_000, b"\xaf\x01first-audio"),
            tag(FLV_TAG_VIDEO, 10_010, b"\x27\x01first-video"),
        ]);
        let second_body = stream(&[
            tag(FLV_TAG_SCRIPT, 0, b"metadata"),
            tag(FLV_TAG_AUDIO, 12, b"\xaf\x00\x12\x10"),
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config"),
            tag(FLV_TAG_AUDIO, 10_020, b"\xaf\x01second-audio"),
            tag(FLV_TAG_VIDEO, 10_030, b"\x27\x01second-video"),
        ]);
        let mut first_upstream = upstream_with_body(first_body.clone()).await;
        let mut second_upstream = follow_up_upstream(second_body.clone()).await;
        let first = response(&format!("http://{}/first.flv", first_upstream.address)).await;
        assert!(
            first_upstream
                .requests
                .try_recv()
                .unwrap()
                .starts_with("GET /first.flv")
        );
        let recovery = test_context(format!("http://{}/second.flv", second_upstream.address));
        let telemetry = Arc::new(ProxyTelemetryCounters::new());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut browser, _) = listener.accept().await.unwrap();
            proxy_with_min_continuation(
                &mut browser,
                first,
                recovery,
                telemetry,
                std::time::Instant::now(),
                Duration::ZERO,
            )
            .await
            .unwrap();
        });
        let mut browser = TcpStream::connect(address).await.unwrap();
        let mut bytes = Vec::new();
        browser.read_to_end(&mut bytes).await.unwrap();
        task.await.unwrap();

        let head_end = bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap()
            + 4;
        let (head, body) = bytes.split_at(head_end);
        let head = String::from_utf8_lossy(head);
        assert_eq!(head.matches("HTTP/1.1 200 OK").count(), 1);
        assert!(!head.to_ascii_lowercase().contains("content-length"));
        assert!(body.starts_with(&first_body[..13]));
        for filtered in [
            b"metadata".as_slice(),
            b"\xaf\x00\x12\x10".as_slice(),
            b"\x17\x00config".as_slice(),
        ] {
            assert_eq!(
                body.windows(filtered.len())
                    .filter(|part| *part == filtered)
                    .count(),
                1
            );
        }
        assert!(body.windows(11).any(|part| part == b"first-audio"));
        assert!(body.windows(11).any(|part| part == b"first-video"));
        assert!(body.windows(12).any(|part| part == b"second-audio"));
        assert!(body.windows(12).any(|part| part == b"second-video"));
        assert!(second_upstream.requests.try_recv().is_ok());
    }

    #[tokio::test]
    async fn slow_initial_response_does_not_extend_a_short_connection() {
        let body = stream(&[
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config"),
            tag(FLV_TAG_VIDEO, 10_000, b"\x27\x01video"),
        ]);
        let mut first_upstream = upstream_with_body(body.clone()).await;
        let first = response(&format!("http://{}/first.flv", first_upstream.address)).await;
        assert!(
            first_upstream
                .requests
                .try_recv()
                .unwrap()
                .starts_with("GET /first.flv")
        );
        let recovery = test_context("http://127.0.0.1:9/should-not-refresh.flv".into());
        let telemetry = Arc::new(ProxyTelemetryCounters::new());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut browser, _) = listener.accept().await.unwrap();
            proxy_with_min_continuation(
                &mut browser,
                first,
                recovery,
                telemetry,
                std::time::Instant::now()
                    .checked_sub(Duration::from_millis(50))
                    .unwrap(),
                Duration::from_millis(100),
            )
            .await
            .unwrap();
        });
        let mut browser = TcpStream::connect(address).await.unwrap();
        let mut bytes = Vec::new();
        browser.read_to_end(&mut bytes).await.unwrap();
        task.await.unwrap();

        assert!(bytes.windows(body.len()).any(|window| window == body));
    }

    #[test]
    fn fixture_uses_standard_flv_layout() {
        let tag = tag(FLV_TAG_AUDIO, 0x0102_0304, b"x");
        assert_eq!(tag.len(), 16);
        assert_eq!(&tag[1..4], [0, 0, 1]);
        assert_eq!(&tag[4..7], [2, 3, 4]);
        assert_eq!(tag[7], 1);
        assert_eq!(&tag[12..], &[0, 0, 0, 12]);
    }

    #[test]
    fn flv_response_accepts_generic_cdn_type_but_rejects_explicit_html() {
        assert!(super::is_flv_response(
            "application/octet-stream; charset=binary",
            "https://cdn.example/live.flv?token=x"
        ));
        assert!(super::is_flv_response(
            "video/x-flv",
            "https://cdn.example/live"
        ));
        assert!(super::is_flv_response(
            "application/octet-stream",
            "https://cdn.example/live.FLV?token=x"
        ));
        assert!(!super::is_flv_response(
            "text/html; charset=utf-8",
            "https://cdn.example/live.flv"
        ));
        assert!(!super::is_flv_response(
            "application/octet-stream",
            "https://cdn.example/live?next=clip.flv"
        ));
        assert!(!super::is_flv_response(
            "application/octet-stream",
            "https://cdn.example/live.flv/segment"
        ));
    }

    #[test]
    fn continuation_keeps_one_header_and_filters_reconnected_initial_tags() {
        let metadata = tag(FLV_TAG_SCRIPT, 0, b"metadata");
        let audio_config = tag(FLV_TAG_AUDIO, 12, b"\xaf\x00\x12\x10");
        let video_config = tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00\0\0\0");
        let first = stream(&[
            metadata.clone(),
            audio_config.clone(),
            video_config.clone(),
            tag(FLV_TAG_AUDIO, 10_000, b"\xaf\x01audio"),
            tag(FLV_TAG_VIDEO, 10_010, b"\x27\x01video"),
        ]);
        let second = stream(&[
            metadata,
            audio_config,
            video_config,
            tag(FLV_TAG_AUDIO, 10_000, b"\xaf\x01overlap"),
            tag(FLV_TAG_VIDEO, 10_010, b"\x27\x01overlap"),
            tag(FLV_TAG_AUDIO, 10_020, b"\xaf\x01next"),
            tag(FLV_TAG_VIDEO, 10_030, b"\x27\x01next"),
        ]);

        let mut relay = Relay::default();
        assert_eq!(relay.push(&first, true).unwrap(), first);
        relay.begin_connection();
        let continued = relay.push(&second, false).unwrap();
        assert!(!continued.starts_with(b"FLV"));
        assert!(!continued.windows(8).any(|window| window == b"metadata"));
        assert!(
            !continued
                .windows(4)
                .any(|window| window == b"\xaf\x00\x12\x10")
        );
        assert!(
            !continued
                .windows(5)
                .any(|window| window == b"\x17\x00\0\0\0")
        );
        assert!(
            !continued
                .windows(9)
                .any(|window| window == b"\xaf\x01overlap")
        );
        assert!(
            !continued
                .windows(9)
                .any(|window| window == b"\x27\x01overlap")
        );
        assert!(continued.windows(6).any(|window| window == b"\xaf\x01next"));
        assert!(continued.windows(6).any(|window| window == b"\x27\x01next"));
    }

    #[test]
    fn truncated_tag_is_held_until_complete() {
        let audio = tag(FLV_TAG_AUDIO, 1, b"\xaf\x01payload");
        let mut input = stream(&[tag(FLV_TAG_SCRIPT, 0, b"metadata"), audio.clone()]);
        input.truncate(input.len() - 2);
        let mut relay = Relay::default();
        assert!(relay.push(&input, true).unwrap().len() < input.len());
        let tail = audio[audio.len() - 2..].to_vec();
        let output = relay.push(&tail, true).unwrap();
        assert!(output.windows(7).any(|window| window == b"payload"));
    }

    #[test]
    fn changed_sequence_header_stops_continuation() {
        let mut relay = Relay::default();
        let first = stream(&[
            tag(FLV_TAG_AUDIO, 12, b"\xaf\x00\x12\x10"),
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config-a"),
        ]);
        relay.push(&first, true).unwrap();
        relay.begin_connection();
        let second = stream(&[
            tag(FLV_TAG_AUDIO, 12, b"\xaf\x00\x12\x10"),
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config-b"),
        ]);
        assert!(relay.push(&second, false).is_err());
    }

    #[test]
    fn small_overlap_is_dropped_but_large_backward_jump_stops() {
        let mut relay = Relay::default();
        let first = stream(&[
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config"),
            tag(FLV_TAG_VIDEO, 200_000, b"\x27\x01video"),
        ]);
        relay.push(&first, true).unwrap();

        relay.begin_connection();
        let overlap = stream(&[
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config"),
            tag(FLV_TAG_VIDEO, 195_000, b"\x27\x01overlap"),
            tag(FLV_TAG_VIDEO, 205_000, b"\x27\x01next"),
        ]);
        let output = relay.push(&overlap, false).unwrap();
        assert!(!output.windows(9).any(|window| window == b"\x27\x01overlap"));
        assert!(output.windows(6).any(|window| window == b"\x27\x01next"));

        relay.begin_connection();
        let backward = stream(&[
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config"),
            tag(FLV_TAG_VIDEO, 180_000, b"\x27\x01old"),
        ]);
        assert!(relay.push(&backward, false).is_err());
    }

    #[test]
    fn repeated_overlap_cannot_hide_a_large_backward_jump() {
        let mut relay = Relay::default();
        let first = stream(&[
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config"),
            tag(FLV_TAG_VIDEO, 200_000, b"\x27\x01video"),
        ]);
        relay.push(&first, true).unwrap();

        relay.begin_connection();
        let overlap_then_backward = stream(&[
            tag(FLV_TAG_VIDEO, 4_177, b"\x17\x00config"),
            tag(FLV_TAG_VIDEO, 199_000, b"\x27\x01overlap-1"),
            tag(FLV_TAG_VIDEO, 189_000, b"\x27\x01old"),
        ]);
        assert!(relay.push(&overlap_then_backward, false).is_err());
    }
}
