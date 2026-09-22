//! P-01 回归：使用本地可控上游验证缓存提交边界，不依赖 CDN 或真实媒体解码。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::{HlsResources, ManifestPin, ProxyLoopContext, ProxyTelemetryCounters, handle_client};
use crate::media_cache::{MediaCache, MediaCacheSpec};

const WAIT: Duration = Duration::from_secs(5);
const RANGE_REQUEST: &[u8] =
    b"GET /live HTTP/1.1\r\nHost: localhost\r\nRange: bytes=0-799\r\nConnection: close\r\n\r\n";

fn complete_body() -> Vec<u8> {
    // 包含非 UTF-8 字节，必须逐字节一致，不能用字符串后缀充当完整性断言。
    (0..800).map(|i| (i % 256) as u8).collect()
}

fn response(status: u16, range: &str, framing: &str, body: &[u8]) -> Vec<u8> {
    let mut result = format!(
        "HTTP/1.1 {status} Test\r\nContent-Type: video/mp4\r\nContent-Range: {range}\r\n{framing}\r\nConnection: close\r\n\r\n"
    )
    .into_bytes();
    result.extend_from_slice(body);
    result
}

fn complete_response() -> Vec<u8> {
    response(
        206,
        "bytes 0-799/1600",
        "Content-Length: 800",
        &complete_body(),
    )
}

async fn read_request(stream: &mut TcpStream) {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(stream.read_u8().await.unwrap());
        assert!(head.len() < 4096);
    }
    assert!(
        String::from_utf8(head)
            .unwrap()
            .to_lowercase()
            .contains("range: bytes=0-799")
    );
}

struct Fixture {
    context: ProxyLoopContext,
    store: MediaCache,
    key: String,
    root: PathBuf,
    reply: Arc<Mutex<Vec<u8>>>,
    server: JoinHandle<()>,
}

impl Fixture {
    async fn new(reply: Vec<u8>) -> Self {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let reply = Arc::new(Mutex::new(reply));
        let server_reply = reply.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = upstream.accept().await {
                read_request(&mut stream).await;
                let bytes = server_reply.lock().unwrap().clone();
                let _ = stream.write_all(&bytes).await;
            }
        });
        let root =
            std::env::temp_dir().join(format!("rlive-cache-integrity-{}", uuid::Uuid::new_v4()));
        let store = MediaCache::new(root.clone());
        let spec = Arc::new(MediaCacheSpec::new(
            "BVfixture:1:112:v".into(),
            "video/mp4",
            vec![(0, 799)],
        ));
        let key = spec.key_for_range(0, 799).unwrap();
        let context = ProxyLoopContext {
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(WAIT)
                .build()
                .unwrap(),
            url: format!("http://{upstream_address}/media.m4s").into(),
            headers: Arc::new(HashMap::new()),
            hls_resources: Arc::new(HlsResources::new()),
            local_origin: "http://127.0.0.1".into(),
            force_hls: false,
            twitch_ad_recovery: None,
            manifest_pin: Arc::new(ManifestPin::default()),
            telemetry: Arc::new(ProxyTelemetryCounters::new()),
            media_cache: Some(spec),
            media_cache_store: Some(store.clone()),
        };
        Self {
            context,
            store,
            key,
            root,
            reply,
            server,
        }
    }

    /// 每次请求都等待真实 handle_client 结束，避免以“客户端收完”代替正常 EOF。
    async fn start_request(&self) -> (TcpStream, JoinHandle<Result<(), String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let context = self.context.clone();
        let handler = tokio::spawn(async move { handle_client(&mut socket, context).await });
        client.write_all(RANGE_REQUEST).await.unwrap();
        (client, handler)
    }

    async fn fetch(&self) -> (Vec<u8>, Result<(), String>) {
        timeout(WAIT, async {
            let (mut client, handler) = self.start_request().await;
            let mut bytes = Vec::new();
            client.read_to_end(&mut bytes).await.unwrap();
            let result = handler.await.unwrap();
            (bytes, result)
        })
        .await
        .expect("本地代理请求未结束")
    }

    fn upstream_requests(&self) -> u64 {
        self.context
            .telemetry
            .upstream_requests
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    async fn wait_for_complete_cache(&self) {
        timeout(WAIT, async {
            loop {
                if self.store.get(&self.key).await.as_deref() == Some(complete_body().as_slice()) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("完整分片未提交到缓存");
    }

    async fn assert_not_cached(&self) {
        // 后台提交是尽力而为的 spawn；留出窗口检测错误路径迟到的坏提交。
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert_eq!(
                self.store.get(&self.key).await,
                None,
                "畸形或中断响应不得落盘"
            );
        }
    }

    async fn assert_refetch_and_cache(&self, requests_before: u64) {
        *self.reply.lock().unwrap() = complete_response();
        let (bytes, result) = self.fetch().await;
        result.unwrap();
        assert_eq!(body(&bytes), complete_body());
        assert_eq!(
            self.upstream_requests(),
            requests_before + 1,
            "无效缓存必须回源"
        );
        self.wait_for_complete_cache().await;
        let (bytes, result) = self.fetch().await;
        result.unwrap();
        assert_eq!(body(&bytes), complete_body());
        assert_eq!(
            self.upstream_requests(),
            requests_before + 1,
            "完整缓存不应再次回源"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn body(response: &[u8]) -> &[u8] {
    let start = response
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap()
        + 4;
    &response[start..]
}

#[tokio::test]
async fn media_cache_rejects_short_empty_and_long_bodies_even_with_clean_eof() {
    for length in [0, 7, 799, 801, 1600] {
        let bytes = vec![42; length];
        let fixture = Fixture::new(response(
            206,
            "bytes 0-799/1600",
            &format!("Content-Length: {length}"),
            &bytes,
        ))
        .await;
        let (forwarded, result) = fixture.fetch().await;
        result.unwrap();
        assert_eq!(body(&forwarded), bytes, "只跳过缓存，不篡改上游正文");
        fixture.assert_not_cached().await;
        fixture.assert_refetch_and_cache(1).await;
    }
}

#[tokio::test]
async fn media_cache_rejects_read_failure_even_after_expected_bytes() {
    // 第一种是 Content-Length 体中断；第二种已经收到精确字节数，
    // 但 chunked 缺结束块，仍不算上游正常 EOF。
    let mut unterminated_chunk = b"320\r\n".to_vec();
    unterminated_chunk.extend_from_slice(&complete_body());
    unterminated_chunk.extend_from_slice(b"\r\n");
    for reply in [
        response(206, "bytes 0-799/1600", "Content-Length: 800", b"prefix"),
        response(
            206,
            "bytes 0-799/1600",
            "Transfer-Encoding: chunked",
            &unterminated_chunk,
        ),
    ] {
        let fixture = Fixture::new(reply).await;
        let (_, result) = fixture.fetch().await;
        assert!(result.is_err(), "上游截断必须走读取失败路径");
        fixture.assert_not_cached().await;
        fixture.assert_refetch_and_cache(1).await;
    }
}

#[tokio::test]
async fn media_cache_accepts_complete_chunked_body_without_content_length() {
    let mut chunks = Vec::new();
    for chunk in complete_body().chunks(100) {
        chunks.extend_from_slice(b"64\r\n");
        chunks.extend_from_slice(chunk);
        chunks.extend_from_slice(b"\r\n");
    }
    chunks.extend_from_slice(b"0\r\n\r\n");
    let fixture = Fixture::new(response(
        206,
        "bytes 0-799/1600",
        "Transfer-Encoding: chunked",
        &chunks,
    ))
    .await;
    let (bytes, result) = fixture.fetch().await;
    result.unwrap();
    assert_eq!(body(&bytes), complete_body());
    fixture.wait_for_complete_cache().await;
    fixture.server.abort();
    let (bytes, result) = fixture.fetch().await;
    result.unwrap();
    assert_eq!(body(&bytes), complete_body());
    assert_eq!(fixture.upstream_requests(), 1);
}

#[tokio::test]
async fn media_cache_rejects_wrong_status_or_content_range() {
    for (status, range) in [(200, "bytes 0-799/1600"), (206, "bytes 800-1599/1600")] {
        let fixture = Fixture::new(response(
            status,
            range,
            "Content-Length: 800",
            &complete_body(),
        ))
        .await;
        fixture.fetch().await.1.unwrap();
        fixture.assert_not_cached().await;
        fixture.assert_refetch_and_cache(1).await;
    }
}

#[tokio::test]
async fn media_cache_treats_old_wrong_length_entries_as_misses() {
    for length in [0, 7, 801] {
        let fixture = Fixture::new(complete_response()).await;
        fixture.store.put(&fixture.key, &vec![42; length]).await;
        fixture.assert_refetch_and_cache(0).await;
    }
}

#[tokio::test]
async fn media_cache_discards_prefix_when_client_disconnects_between_chunks() {
    timeout(WAIT, async {
        let mut fixture = Fixture::new(complete_response()).await;
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        let recovery_url = fixture.context.url.clone();
        fixture.context.url = format!("http://{address}/media.m4s").into();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = upstream.accept().await.unwrap();
            read_request(&mut stream).await;
            stream
                .write_all(&response(
                    206,
                    "bytes 0-799/1600",
                    "Content-Length: 800",
                    b"first-block",
                ))
                .await
                .unwrap();
            release_rx.await.unwrap();
            // 只补一小块，仍未读满 800 字节；下游 RST 必须让 handle_client 放弃缓存。
            let _ = stream.write_all(b"second-block").await;
            let mut rest = Vec::new();
            let _ = stream.read_to_end(&mut rest).await;
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        // 复制同一个内核 socket，只用于确认 RST 已抵达，再让上游发第二块。
        // 不依赖 sleep 猜测 TCP 事件与 Tokio 调度的顺序。
        let duplicate = socket2::SockRef::from(&socket).try_clone().unwrap();
        let mut disconnect_probe = TcpStream::from_std(duplicate.into()).unwrap();
        let context = fixture.context.clone();
        let handler = tokio::spawn(async move { handle_client(&mut socket, context).await });
        client.write_all(RANGE_REQUEST).await.unwrap();
        let mut received = Vec::new();
        while !received.ends_with(b"first-block") {
            received.push(client.read_u8().await.unwrap());
        }
        socket2::SockRef::from(&client)
            .set_linger(Some(Duration::ZERO))
            .unwrap();
        drop(client); // RST，而不是仍允许接收正文的半关闭。
        assert!(!matches!(disconnect_probe.read(&mut [0]).await, Ok(1..)));
        drop(disconnect_probe);
        release_tx.send(()).unwrap();
        handler.await.unwrap().unwrap();
        server.await.unwrap();
        fixture.assert_not_cached().await;
        fixture.context.url = recovery_url;
        fixture.assert_refetch_and_cache(1).await;
    })
    .await
    .expect("客户端离开后代理未及时结束");
}
