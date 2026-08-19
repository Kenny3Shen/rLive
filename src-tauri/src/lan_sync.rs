use std::collections::HashSet;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{StreamExt, stream::FuturesUnordered};
use reqwest::redirect::Policy;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::error::{AppError, AppResult};
use crate::profile::MAX_PROFILE_BYTES;

const PROFILE_PATH: &str = "/rlive-sync/v2/profile";
const LEGACY_PROFILE_PATH: &str = "/rlive-sync/v1/profile";
const SYNC_PROTOCOL_VERSION: &str = "2";
const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const RECEIVE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_FAILED_CODES: u8 = 5;
const MAX_REQUEST_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LanSyncSessionState {
    Waiting,
    Completed,
    Expired,
    Locked,
    Stopped,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LanSyncSessionInfo {
    pub addresses: Vec<String>,
    pub code: String,
    pub expires_at: i64,
    pub status: LanSyncSessionState,
}

struct ActiveSession {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
    info: Arc<Mutex<LanSyncSessionInfo>>,
}

pub struct LanSyncManager {
    generation: AtomicU64,
    active: Mutex<Option<ActiveSession>>,
}

impl Default for LanSyncManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LanSyncManager {
    pub fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            active: Mutex::new(None),
        }
    }

    pub async fn start(&self, profile: String) -> AppResult<LanSyncSessionInfo> {
        if profile.len() as u64 > MAX_PROFILE_BYTES {
            return Err(AppError::new(
                "profile_too_large",
                "当前配置数据超过 16 MiB 局域网同步限制",
            ));
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.stop_active();

        let listeners = bind_private_listeners().await?;
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err(AppError::new(
                "lan_sync_cancelled",
                "局域网同步会话已被新的操作取消",
            ));
        }

        let addresses = listeners
            .iter()
            .filter_map(|listener| listener.local_addr().ok())
            .map(|address| format!("http://{address}"))
            .collect::<Vec<_>>();
        let code = pairing_code();
        let info = LanSyncSessionInfo {
            addresses,
            code: code.clone(),
            expires_at: chrono::Utc::now().timestamp_millis() + SESSION_TTL.as_millis() as i64,
            status: LanSyncSessionState::Waiting,
        };
        let shared_info = Arc::new(Mutex::new(info.clone()));
        let (shutdown, shutdown_rx) = watch::channel(false);
        let task_info = Arc::clone(&shared_info);
        let task = tauri::async_runtime::spawn(async move {
            run_session(listeners, profile, code, shutdown_rx, task_info).await;
        });

        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::new("lan_sync_lock_error", "局域网同步状态暂不可用"))?;
        if self.generation.load(Ordering::SeqCst) != generation {
            let _ = shutdown.send(true);
            task.abort();
            return Err(AppError::new(
                "lan_sync_cancelled",
                "局域网同步会话已被新的操作取消",
            ));
        }
        *active = Some(ActiveSession {
            shutdown,
            task,
            info: shared_info,
        });
        Ok(info)
    }

    pub fn status(&self) -> AppResult<Option<LanSyncSessionInfo>> {
        let active = self
            .active
            .lock()
            .map_err(|_| AppError::new("lan_sync_lock_error", "局域网同步状态暂不可用"))?;
        active
            .as_ref()
            .map(|session| {
                session
                    .info
                    .lock()
                    .map(|info| info.clone())
                    .map_err(|_| AppError::new("lan_sync_lock_error", "局域网同步状态暂不可用"))
            })
            .transpose()
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.stop_active();
    }

    fn stop_active(&self) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let Some(session) = active.take() else {
            return;
        };
        set_session_state(&session.info, LanSyncSessionState::Stopped);
        let _ = session.shutdown.send(true);
        session.task.abort();
    }
}

impl Drop for LanSyncManager {
    fn drop(&mut self) {
        self.stop_active();
    }
}

fn pairing_code() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let value = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 1_000_000;
    format!("{value:06}")
}

fn set_session_state(info: &Arc<Mutex<LanSyncSessionInfo>>, state: LanSyncSessionState) {
    if let Ok(mut info) = info.lock()
        && info.status == LanSyncSessionState::Waiting
    {
        info.status = state;
    }
}

async fn bind_private_listeners() -> AppResult<Vec<TcpListener>> {
    let addresses = private_ipv4_addresses()?;
    if addresses.is_empty() {
        return Err(AppError::new(
            "lan_sync_no_network",
            "未找到可用的局域网 IPv4 地址，请先连接同一 Wi-Fi 或有线网络",
        ));
    }

    let mut listeners = Vec::new();
    for address in addresses {
        if let Ok(listener) = TcpListener::bind(SocketAddr::new(IpAddr::V4(address), 0)).await {
            listeners.push(listener);
        }
    }
    if listeners.is_empty() {
        return Err(AppError::new(
            "lan_sync_bind_error",
            "无法在局域网网卡上创建同步服务，请检查系统防火墙或网络权限",
        ));
    }
    Ok(listeners)
}

fn private_ipv4_addresses() -> AppResult<Vec<Ipv4Addr>> {
    let mut addresses = HashSet::new();
    for interface in if_addrs::get_if_addrs().map_err(|error| {
        AppError::new(
            "lan_sync_interfaces_error",
            format!("读取局域网网卡失败: {error}"),
        )
    })? {
        if let IpAddr::V4(address) = interface.ip()
            && is_lan_ipv4(address)
            && !address.is_loopback()
        {
            addresses.insert(address);
        }
    }
    let mut addresses = addresses.into_iter().collect::<Vec<_>>();
    addresses.sort_by_key(|address| (lan_address_priority(*address), address.octets()));
    Ok(addresses)
}

fn lan_address_priority(address: Ipv4Addr) -> u8 {
    match address.octets() {
        [192, 168, ..] => 0,
        [10, ..] => 1,
        [172, second, ..] if (16..=31).contains(&second) => 2,
        [100, second, ..] if (64..=127).contains(&second) => 3,
        _ => 4,
    }
}

fn is_lan_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    address.is_private()
        || address.is_link_local()
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
}

fn is_lan_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_loopback() || is_lan_ipv4(address),
        IpAddr::V6(address) => {
            address.is_loopback() || address.is_unique_local() || address.is_unicast_link_local()
        }
    }
}

async fn accept_any(listeners: &[TcpListener]) -> io::Result<(TcpStream, SocketAddr)> {
    let mut accepts = FuturesUnordered::new();
    for listener in listeners {
        accepts.push(listener.accept());
    }
    while let Some(result) = accepts.next().await {
        if result.is_ok() {
            return result;
        }
    }
    Err(io::Error::other("every LAN sync listener stopped"))
}

async fn run_session(
    listeners: Vec<TcpListener>,
    profile: String,
    code: String,
    mut shutdown: watch::Receiver<bool>,
    info: Arc<Mutex<LanSyncSessionInfo>>,
) {
    let deadline = Instant::now() + SESSION_TTL;
    let mut failed_codes = 0u8;

    loop {
        let accepted = tokio::select! {
            _ = shutdown.changed() => {
                set_session_state(&info, LanSyncSessionState::Stopped);
                return;
            }
            _ = tokio::time::sleep_until(deadline) => {
                set_session_state(&info, LanSyncSessionState::Expired);
                return;
            }
            accepted = accept_any(&listeners) => accepted,
        };
        let Ok((mut stream, peer)) = accepted else {
            set_session_state(&info, LanSyncSessionState::Stopped);
            return;
        };
        if !is_lan_ip(peer.ip()) {
            let _ = write_response(&mut stream, 403, "Forbidden", "").await;
            continue;
        }

        let request = match tokio::time::timeout(REQUEST_TIMEOUT, read_request(&mut stream)).await {
            Ok(Ok(request)) => request,
            _ => {
                let _ = write_response(&mut stream, 400, "Bad Request", "").await;
                continue;
            }
        };
        if request.method != "GET" || request.path != PROFILE_PATH {
            let _ = write_response(&mut stream, 404, "Not Found", "").await;
            continue;
        }
        if !request
            .code
            .as_deref()
            .is_some_and(|candidate| constant_time_eq(candidate, &code))
        {
            failed_codes = failed_codes.saturating_add(1);
            let _ = write_response(&mut stream, 401, "Unauthorized", "").await;
            if failed_codes >= MAX_FAILED_CODES {
                set_session_state(&info, LanSyncSessionState::Locked);
                return;
            }
            continue;
        }

        if write_response(&mut stream, 200, "OK", &profile)
            .await
            .is_ok()
        {
            set_session_state(&info, LanSyncSessionState::Completed);
            return;
        }
    }
}

struct SyncRequest {
    method: String,
    path: String,
    code: Option<String>,
}

async fn read_request(stream: &mut TcpStream) -> io::Result<SyncRequest> {
    let mut buffer = Vec::with_capacity(1024);
    while buffer.len() < MAX_REQUEST_BYTES {
        let mut chunk = [0u8; 1024];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    if !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "incomplete HTTP request",
        ));
    }
    let text = std::str::from_utf8(&buffer)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request is not UTF-8"))?;
    let mut lines = text.split("\r\n");
    let mut request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?
        .split_ascii_whitespace();
    let method = request_line.next().unwrap_or_default().to_owned();
    let path = request_line.next().unwrap_or_default().to_owned();
    if request_line.next().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid request line",
        ));
    }
    let code = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.eq_ignore_ascii_case("authorization") {
            return None;
        }
        value.trim().strip_prefix("Bearer ").map(str::to_owned)
    });
    Ok(SyncRequest { method, path, code })
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-rLive-Sync-Version: {SYNC_PROTOCOL_VERSION}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

fn constant_time_eq(candidate: &str, expected: &str) -> bool {
    let candidate = candidate.as_bytes();
    let expected = expected.as_bytes();
    if candidate.len() != expected.len() {
        return false;
    }
    candidate
        .iter()
        .zip(expected)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn normalized_receive_url(endpoint: &str) -> AppResult<reqwest::Url> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    let candidate = if trimmed.starts_with("http://") {
        trimmed.to_owned()
    } else {
        format!("http://{trimmed}")
    };
    let mut url = reqwest::Url::parse(&candidate).map_err(|_| {
        AppError::new(
            "lan_sync_invalid_address",
            "同步地址无效，请输入发送设备显示的完整局域网地址",
        )
    })?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_none()
    {
        return Err(AppError::new(
            "lan_sync_invalid_address",
            "仅支持带端口的 HTTP 局域网同步地址",
        ));
    }
    let host = url
        .host_str()
        .map(|host| host.trim_start_matches('[').trim_end_matches(']'))
        .and_then(|host| host.parse::<IpAddr>().ok())
        .filter(|address| is_lan_ip(*address))
        .ok_or_else(|| {
            AppError::new(
                "lan_sync_non_local_address",
                "同步地址必须是私有局域网 IP，不能使用公网地址或域名",
            )
        })?;
    if url.path() == LEGACY_PROFILE_PATH {
        return Err(AppError::new(
            "lan_sync_protocol_error",
            "目标地址使用了不再支持的 rLive 局域网同步协议",
        ));
    }
    if !is_lan_ip(host) || !matches!(url.path(), "" | "/" | PROFILE_PATH) {
        return Err(AppError::new(
            "lan_sync_invalid_address",
            "同步地址路径无效，请直接使用发送设备显示的地址",
        ));
    }
    url.set_path(PROFILE_PATH);
    Ok(url)
}

pub async fn receive_profile(endpoint: &str, code: &str) -> AppResult<Vec<u8>> {
    let code = code.trim();
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::new(
            "lan_sync_invalid_code",
            "配对码应为 6 位数字",
        ));
    }
    let url = normalized_receive_url(endpoint)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(REQUEST_TIMEOUT)
        .timeout(RECEIVE_TIMEOUT)
        .build()
        .map_err(|error| {
            AppError::new(
                "lan_sync_client_error",
                format!("创建局域网同步连接失败: {error}"),
            )
        })?;
    let response = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {code}"))
        .send()
        .await
        .map_err(|_| {
            AppError::new(
                "lan_sync_connect_error",
                "无法连接发送设备，请确认两台设备位于同一局域网且系统防火墙已放行 rLive",
            )
            .retryable()
        })?;
    let protocol_ok = response
        .headers()
        .get("x-rlive-sync-version")
        .and_then(|value| value.to_str().ok())
        == Some(SYNC_PROTOCOL_VERSION);
    if !protocol_ok {
        return Err(AppError::new(
            "lan_sync_protocol_error",
            "目标地址不是受支持的 rLive 局域网同步服务",
        ));
    }
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::new(
            "lan_sync_pairing_failed",
            "配对码错误，或发送端会话已被锁定",
        ));
    }
    if !response.status().is_success() {
        return Err(AppError::new(
            "lan_sync_remote_error",
            format!(
                "发送设备拒绝同步请求（HTTP {}）",
                response.status().as_u16()
            ),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROFILE_BYTES)
    {
        return Err(AppError::new(
            "profile_too_large",
            "发送设备的配置数据超过 16 MiB 限制",
        ));
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            AppError::new(
                "lan_sync_transfer_error",
                "局域网配置传输中断，请重新创建同步会话",
            )
            .retryable()
        })?;
        if bytes.len().saturating_add(chunk.len()) as u64 > MAX_PROFILE_BYTES {
            return Err(AppError::new(
                "profile_too_large",
                "发送设备的配置数据超过 16 MiB 限制",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receive_endpoint_accepts_only_local_ip_literals() {
        assert_eq!(
            normalized_receive_url("192.168.1.20:43210")
                .unwrap()
                .as_str(),
            "http://192.168.1.20:43210/rlive-sync/v2/profile"
        );
        assert!(normalized_receive_url("http://127.0.0.1:43210").is_ok());
        assert!(normalized_receive_url("https://192.168.1.20:43210").is_err());
        assert!(normalized_receive_url("http://example.test:43210").is_err());
        assert!(normalized_receive_url("http://8.8.8.8:43210").is_err());
        assert!(normalized_receive_url("http://user@192.168.1.20:43210").is_err());
        assert!(normalized_receive_url("http://192.168.1.20:43210/other").is_err());
        assert!(normalized_receive_url("http://192.168.1.20:43210?code=123456").is_err());
        assert_eq!(
            normalized_receive_url("http://[::1]:43210")
                .unwrap()
                .as_str(),
            "http://[::1]:43210/rlive-sync/v2/profile"
        );
        let error =
            normalized_receive_url("http://192.168.1.20:43210/rlive-sync/v1/profile").unwrap_err();
        assert_eq!(error.code, "lan_sync_protocol_error");
    }

    #[test]
    fn pairing_codes_use_fixed_width_and_exact_comparison() {
        let code = pairing_code();
        assert_eq!(code.len(), 6);
        assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
        assert!(constant_time_eq("123456", "123456"));
        assert!(!constant_time_eq("123457", "123456"));
        assert!(!constant_time_eq("12345", "123456"));
    }

    #[tokio::test]
    async fn sync_session_rejects_a_bad_code_then_serves_once() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let info = Arc::new(Mutex::new(LanSyncSessionInfo {
            addresses: vec![endpoint.clone()],
            code: "123456".into(),
            expires_at: 0,
            status: LanSyncSessionState::Waiting,
        }));
        let (_shutdown_tx, shutdown) = watch::channel(false);
        let task_info = Arc::clone(&info);
        let task = tokio::spawn(async move {
            run_session(
                vec![listener],
                r#"{"version":2}"#.into(),
                "123456".into(),
                shutdown,
                task_info,
            )
            .await;
        });

        let error = receive_profile(&endpoint, "000000").await.unwrap_err();
        assert_eq!(error.code, "lan_sync_pairing_failed");
        let profile = receive_profile(&endpoint, "123456").await.unwrap();
        assert_eq!(profile, br#"{"version":2}"#);
        task.await.unwrap();
        assert_eq!(info.lock().unwrap().status, LanSyncSessionState::Completed);
    }

    #[tokio::test]
    async fn sync_session_locks_after_five_bad_codes() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let info = Arc::new(Mutex::new(LanSyncSessionInfo {
            addresses: vec![endpoint.clone()],
            code: "123456".into(),
            expires_at: 0,
            status: LanSyncSessionState::Waiting,
        }));
        let (_shutdown_tx, shutdown) = watch::channel(false);
        let task_info = Arc::clone(&info);
        let task = tokio::spawn(async move {
            run_session(
                vec![listener],
                r#"{"version":2}"#.into(),
                "123456".into(),
                shutdown,
                task_info,
            )
            .await;
        });

        for _ in 0..MAX_FAILED_CODES {
            let error = receive_profile(&endpoint, "000000").await.unwrap_err();
            assert_eq!(error.code, "lan_sync_pairing_failed");
        }
        task.await.unwrap();
        assert_eq!(info.lock().unwrap().status, LanSyncSessionState::Locked);
    }
}
