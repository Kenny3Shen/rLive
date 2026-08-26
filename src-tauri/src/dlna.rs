//! DLNA 投屏：SSDP 设备发现、AVTransport 控制与局域网流中继。
//!
//! 电视端渲染器自行拉流，无法携带各平台的 UA/Referer，也访问不到绑定在
//! `127.0.0.1` 的 [`crate::stream_proxy`]。因此投屏走独立的中继代理：绑定
//! `0.0.0.0` 的临时端口，按投屏时登记的请求头回源拉流并转发给电视；HLS
//! 播放列表会把子地址改写为中继地址，保证分片请求同样经过中继。
//!
//! 中继仅接受携带本次会话随机令牌的请求，且拒绝回环目标，不会成为开放代理。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

use crate::error::{AppError, AppResult};

const SSDP_MULTICAST_ADDR: &str = "239.255.255.250:1900";
/// SSDP 搜索窗口。多数渲染器在 MX 秒内响应，3 秒足够覆盖局域网。
const SSDP_SEARCH_WINDOW: Duration = Duration::from_secs(3);
const AVTRANSPORT_TYPE: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DlnaDevice {
    /// SSDP 唯一服务名，用于去重。
    pub usn: String,
    /// 设备友好名称（来自设备描述 XML）。
    pub name: String,
    /// 设备描述文档地址；投屏时回传，控制请求以它为基准解析 controlURL。
    pub location: String,
}

#[derive(Debug, Serialize)]
pub struct DlnaCastStatus {
    pub device_name: String,
    pub title: String,
}

#[derive(Debug)]
struct ResolvedDevice {
    name: String,
    control_url: String,
}

pub struct DlnaManager {
    session: Mutex<Option<Arc<CastSessionInner>>>,
    client: reqwest::Client,
}

struct CastSessionInner {
    device_name: String,
    title: String,
    control_url: String,
    relay: RelayHandle,
}

impl Default for DlnaManager {
    fn default() -> Self {
        Self::new()
    }
}

fn dlna_error(message: impl Into<String>) -> AppError {
    AppError::new("dlna_error", message)
}

impl DlnaManager {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            // 设备描述与 SOAP 都在局域网明文 HTTP 上完成；不启用 Cookie，
            // 也绝不复用带平台登录态的客户端。设备地址是局域网 IP，必须
            // 直连，不能被系统/应用 HTTP 代理劫持。
            client: reqwest::Client::builder()
                .user_agent(DEFAULT_UA)
                .no_proxy()
                .build()
                .unwrap_or_default(),
        }
    }

    /// 搜索局域网内的 DLNA 媒体渲染器。
    pub async fn search_devices(&self) -> AppResult<Vec<DlnaDevice>> {
        let responders = ssdp_search().await?;
        let mut devices = Vec::new();
        let mut seen_usn = std::collections::HashSet::new();
        for (location, usn) in responders {
            if !seen_usn.insert(usn.clone()) {
                continue;
            }
            match self.resolve_device(&location).await {
                Ok(resolved) => devices.push(DlnaDevice {
                    usn,
                    name: resolved.name,
                    location,
                }),
                // 单个设备描述失败不应拖垮整个搜索结果；无 AVTransport 的
                // 设备（如仅 DMR 描述不完整）在这里被自然过滤。
                Err(_) => continue,
            }
        }
        devices.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(devices)
    }

    /// 把 `url` 投到指定设备：启动中继、下发 SetAVTransportURI + Play。
    ///
    /// `headers` 是上游播放地址要求的请求头（UA/Referer 等），由中继代为
    /// 注入；电视端只访问本机中继。
    pub async fn cast(
        &self,
        location: String,
        url: String,
        headers: HashMap<String, String>,
        title: String,
    ) -> AppResult<DlnaCastStatus> {
        let _ = self.stop().await;
        let device = self.resolve_device(&location).await?;
        let relay = start_relay(headers).await.map_err(dlna_error)?;

        let host = lan_ipv4()?;
        let encoded_url =
            percent_encoding::utf8_percent_encode(&url, percent_encoding::NON_ALPHANUMERIC);
        let relay_url = format!(
            "http://{host}:{}/stream?url={encoded_url}&token={}",
            relay.port, relay.token
        );
        tracing::info!(%relay_url, "DLNA 投屏中继已就绪");

        if let Err(error) = soap_action(
            &self.client,
            &device.control_url,
            "SetAVTransportURI",
            &format!(
                "<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI>",
                xml_escape(&relay_url)
            ),
        )
        .await
        {
            stop_relay(&relay).await;
            return Err(error);
        }
        if let Err(error) = soap_action(
            &self.client,
            &device.control_url,
            "Play",
            "<InstanceID>0</InstanceID>",
        )
        .await
        {
            stop_relay(&relay).await;
            return Err(error);
        }

        let status = DlnaCastStatus {
            device_name: device.name.clone(),
            title,
        };
        let mut session = self
            .session
            .lock()
            .map_err(|_| dlna_error("投屏状态暂不可用"))?;
        *session = Some(Arc::new(CastSessionInner {
            device_name: status.device_name.clone(),
            title: status.title.clone(),
            control_url: device.control_url,
            relay,
        }));
        Ok(status)
    }

    /// 停止当前投屏（AVTransport Stop 并关闭中继）。重复调用是安全的。
    pub async fn stop(&self) -> AppResult<()> {
        let inner = self.session.lock().ok().and_then(|mut guard| guard.take());
        let Some(inner) = inner else {
            return Ok(());
        };
        let _ = soap_action(
            &self.client,
            &inner.control_url,
            "Stop",
            "<InstanceID>0</InstanceID>",
        )
        .await;
        stop_relay(&inner.relay).await;
        Ok(())
    }

    pub fn status(&self) -> Option<DlnaCastStatus> {
        let session = self.session.lock().ok()?;
        let inner = session.as_ref()?;
        Some(DlnaCastStatus {
            device_name: inner.device_name.clone(),
            title: inner.title.clone(),
        })
    }

    /// 拉取并解析设备描述，定位 friendlyName 与 AVTransport controlURL。
    async fn resolve_device(&self, location: &str) -> AppResult<ResolvedDevice> {
        let xml = self
            .client
            .get(location)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .map_err(|_| dlna_error("获取设备描述失败"))?
            .text()
            .await
            .map_err(|_| dlna_error("读取设备描述失败"))?;
        parse_device_description(&xml, location)
    }
}

/// SSDP M-SEARCH，返回 `(LOCATION, USN)` 列表（按 LOCATION 去重）。
async fn ssdp_search() -> AppResult<Vec<(String, String)>> {
    let socket = UdpSocket::bind(("0.0.0.0", 0))
        .await
        .map_err(|error| dlna_error(format!("SSDP 端口绑定失败: {error}")))?;
    // 同时探测媒体渲染器与根设备：部分电视只应答 rootdevice，
    // 由后续的设备描述解析决定是否真的具备 AVTransport。
    for st in [
        "urn:schemas-upnp-org:device:MediaRenderer:1",
        "upnp:rootdevice",
        "ssdp:all",
    ] {
        let message = format!(
            "M-SEARCH * HTTP/1.1\r\nHOST: {SSDP_MULTICAST_ADDR}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n"
        );
        let _ = socket
            .send_to(message.as_bytes(), SSDP_MULTICAST_ADDR)
            .await;
    }

    let deadline = tokio::time::Instant::now() + SSDP_SEARCH_WINDOW;
    let mut buffer = vec![0_u8; 2048];
    let mut found: Vec<(String, String)> = Vec::new();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline - tokio::time::Instant::now();
        let Ok(result) = tokio::time::timeout(
            remaining.min(Duration::from_millis(500)),
            socket.recv_from(&mut buffer),
        )
        .await
        else {
            break;
        };
        let Ok((length, _source)) = result else {
            continue;
        };
        let text = String::from_utf8_lossy(&buffer[..length]);
        let Some(location) = header_value(&text, "LOCATION") else {
            continue;
        };
        let usn = header_value(&text, "USN").unwrap_or_default();
        if !found.iter().any(|(existing, _)| existing == &location) {
            found.push((location, usn));
        }
    }
    Ok(found)
}

fn header_value(message: &str, header: &str) -> Option<String> {
    message.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case(header)
            .then(|| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

/// 从设备描述 XML 提取 friendlyName 与 AVTransport controlURL。
///
/// 输入是设备自报的受控 XML，这里用正则做有界提取即可，避免为单一
/// 用途引入完整的 XML 解析依赖。
fn parse_device_description(xml: &str, location: &str) -> AppResult<ResolvedDevice> {
    let name = Regex::new(r"<friendlyName[^>]*>([^<]+)</friendlyName>")
        .expect("valid friendlyName regex")
        .captures(xml)
        .and_then(|captures| captures.get(1))
        .map(|matched| matched.as_str().trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "未知设备".into());

    let service_block = Regex::new(r"(?s)<service>(.*?)</service>").expect("valid service regex");
    let control_url = service_block
        .captures_iter(xml)
        .find(|captures| captures[1].contains(AVTRANSPORT_TYPE))
        .and_then(|captures| {
            Regex::new(r"<controlURL>\s*([^<\s]+)\s*</controlURL>")
                .expect("valid controlURL regex")
                .captures(&captures[1])
                .map(|inner| inner[1].to_string())
        })
        .ok_or_else(|| dlna_error("该设备不支持 AVTransport，无法投屏"))?;

    Ok(ResolvedDevice {
        name,
        control_url: resolve_url(location, &control_url),
    })
}

/// 以设备描述地址为基准解析 controlURL（支持绝对/相对路径）。
fn resolve_url(base: &str, target: &str) -> String {
    resolve_relative(base, target)
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn soap_action(
    client: &reqwest::Client,
    control_url: &str,
    action: &str,
    arguments: &str,
) -> AppResult<()> {
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>\
<u:{action} xmlns:u=\"{AVTRANSPORT_TYPE}\">{arguments}</u:{action}>\
</s:Body></s:Envelope>"
    );
    let response = client
        .post(control_url)
        .timeout(Duration::from_secs(5))
        .header("SOAPACTION", format!("\"{AVTRANSPORT_TYPE}#{action}\""))
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .body(body)
        .send()
        .await
        .map_err(|_| dlna_error("投屏指令发送失败，请确认电视与本机在同一局域网"))?;
    if !response.status().is_success() {
        return Err(dlna_error(format!(
            "设备拒绝投屏指令 {action}（HTTP {}）",
            response.status().as_u16()
        )));
    }
    let text = response.text().await.unwrap_or_default();
    if text.contains("UPnPError") {
        return Err(dlna_error("设备返回 UPnP 错误，可能不支持该直播流格式"));
    }
    Ok(())
}

/// 本机的局域网 IPv4，用于拼接电视可访问的中继地址。
fn lan_ipv4() -> AppResult<IpAddr> {
    let interfaces = if_addrs::get_if_addrs().map_err(|_| dlna_error("未能枚举本机网卡"))?;
    interfaces
        .into_iter()
        .filter_map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(address) => Some(address.ip),
            _ => None,
        })
        .find(|ip| is_private_ipv4(*ip))
        .map(IpAddr::V4)
        .ok_or_else(|| dlna_error("未找到可用的局域网 IPv4 地址"))
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    match octets {
        [192, 168, _, _] | [10, ..] => true,
        [172, second, ..] => (16..=32).contains(&second),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// 局域网中继代理
// ---------------------------------------------------------------------------

pub struct RelayHandle {
    port: u16,
    token: String,
    tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    shutdown: Arc<tokio::sync::watch::Sender<bool>>,
}

struct RelayConfig {
    headers: HashMap<String, String>,
    token: String,
}

async fn start_relay(headers: HashMap<String, String>) -> Result<RelayHandle, String> {
    let listener = TcpListener::bind(("0.0.0.0", 0))
        .await
        .map_err(|error| format!("中继端口绑定失败: {error}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();

    let config = Arc::new(RelayConfig {
        headers,
        token: token.clone(),
    });
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));

    let mut shutdown_rx = shutdown_rx;
    let accept_tasks = Arc::clone(&tasks);
    let accept_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                accepted = listener.accept() => {
                    let Ok((socket, _addr)) = accepted else { break };
                    let config = Arc::clone(&config);
                    let task = tokio::spawn(async move {
                        handle_relay_connection(socket, config).await;
                    });
                    if let Ok(mut tasks) = accept_tasks.lock() {
                        tasks.push(task);
                        tasks.retain(|task| !task.is_finished());
                    }
                }
            }
        }
    });
    if let Ok(mut tasks) = tasks.lock() {
        tasks.push(accept_task);
    }

    Ok(RelayHandle {
        port,
        token,
        tasks,
        shutdown: Arc::new(shutdown_tx),
    })
}

async fn stop_relay(relay: &RelayHandle) {
    let _ = relay.shutdown.send(true);
    // 中继连接多为长连接（FLV 直播流），直接 abort 任务组即可。
    if let Ok(mut tasks) = relay.tasks.lock() {
        for task in tasks.drain(..) {
            task.abort();
        }
    }
}

/// 处理一条电视端连接：解析 GET 行 → 校验令牌 → 回源拉流 → 转发。
///
/// HLS 播放列表需要整体改写子地址；其余内容按字节流转发。
async fn handle_relay_connection(mut socket: TcpStream, config: Arc<RelayConfig>) {
    let mut buffer = Vec::with_capacity(1024);
    let mut byte = [0_u8; 1];
    // 逐字节读到行尾空行，避免把 body 字节吞进缓冲区。
    loop {
        match socket.read(&mut byte).await {
            Ok(1) => {
                buffer.push(byte[0]);
                if buffer.ends_with(b"\r\n\r\n") || buffer.ends_with(b"\n\n") {
                    break;
                }
                if buffer.len() > 8192 {
                    return;
                }
            }
            _ => return,
        }
    }
    let request = String::from_utf8_lossy(&buffer);
    let path = request.split_whitespace().nth(1).unwrap_or_default();
    let Some((_, query)) = path.split_once('?') else {
        let _ = write_simple_response(&mut socket, 400, "text/plain", b"missing query").await;
        return;
    };
    let params: HashMap<String, String> = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| {
            (
                key.to_string(),
                percent_encoding::percent_decode_str(value)
                    .decode_utf8_lossy()
                    .to_string(),
            )
        })
        .collect();
    if params.get("token").map(String::as_str) != Some(config.token.as_str()) {
        let _ = write_simple_response(&mut socket, 403, "text/plain", b"forbidden").await;
        return;
    }
    let Some(target) = params.get("url") else {
        let _ = write_simple_response(&mut socket, 400, "text/plain", b"missing url").await;
        return;
    };
    // 防止把中继自身当作跳板形成回环或访问本机服务。
    if is_loopback_target(target) {
        let _ = write_simple_response(&mut socket, 400, "text/plain", b"loopback denied").await;
        return;
    }

    // 中继回源同样直连：上游可能是回环测试源或局域网源，走代理会被
    // 劫持到错误出口。
    let client = reqwest::Client::builder()
        .user_agent(DEFAULT_UA)
        .no_proxy()
        .build()
        .expect("relay http client");
    let mut request = client.get(target);
    for (key, value) in &config.headers {
        request = request.header(key.as_str(), value.as_str());
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => {
            let _ = write_simple_response(&mut socket, 502, "text/plain", b"upstream failed").await;
            return;
        }
    };

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let is_manifest = content_type.contains("mpegurl")
        || content_type.contains("m3u")
        || target.ends_with(".m3u8");

    if is_manifest {
        let Ok(body) = response.text().await else {
            return;
        };
        let rewritten = rewrite_hls_manifest(&body, target, &config.token);
        let payload = rewritten.into_bytes();
        let fallback_type = if content_type.is_empty() {
            "application/vnd.apple.mpegurl"
        } else {
            &content_type
        };
        let _ = write_simple_response(&mut socket, 200, fallback_type, &payload).await;
        return;
    }

    let head =
        format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n");
    if socket.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                if socket.write_all(&bytes).await.is_err() {
                    return;
                }
            }
            Err(_) => return,
        }
    }
    let _ = socket.flush().await;
}

fn is_loopback_target(target: &str) -> bool {
    let lowercase = target.to_ascii_lowercase();
    lowercase.starts_with("http://127.")
        || lowercase.starts_with("http://localhost")
        || lowercase.starts_with("http://[::1]")
        || lowercase.starts_with("http://0.0.0.0")
        || lowercase.starts_with("https://127.")
        || lowercase.starts_with("https://localhost")
}

async fn write_simple_response(
    socket: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(head.as_bytes()).await?;
    socket.write_all(body).await?;
    socket.flush().await
}

/// 把 HLS 播放列表中的子地址改写为本机中继地址。
fn rewrite_hls_manifest(manifest: &str, manifest_url: &str, token: &str) -> String {
    manifest
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                // URI="..." 属性（EXT-X-KEY / EXT-X-MEDIA / EXT-X-I-FRAME等）同样要改写。
                return rewrite_uri_attributes(line, manifest_url, token);
            }
            let absolute = resolve_relative(manifest_url, trimmed);
            relay_url(&absolute, token)
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

fn rewrite_uri_attributes(line: &str, base: &str, token: &str) -> String {
    let pattern = Regex::new(r#"URI="([^"]+)""#).expect("valid uri regex");
    pattern
        .replace_all(line, |captures: &regex::Captures| {
            let absolute = resolve_relative(base, &captures[1]);
            format!("URI=\"{}\"", relay_url(&absolute, token))
        })
        .to_string()
}

fn relay_url(target: &str, token: &str) -> String {
    let encoded = percent_encoding::utf8_percent_encode(target, percent_encoding::NON_ALPHANUMERIC);
    format!("/stream?url={encoded}&token={token}")
}

/// 相对地址基于清单 URL 解析为绝对地址。
fn resolve_relative(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(base_url) = reqwest::Url::parse(base)
        && let Ok(resolved) = base_url.join(target)
    {
        return resolved.to_string();
    }
    target.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_description_extracts_avtransport_control_url() {
        let xml = r#"
<root>
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>客厅电视</friendlyName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/rc/control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/avt/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>"#;

        let resolved = parse_device_description(xml, "http://192.168.1.5:49152/desc.xml").unwrap();

        assert_eq!(resolved.name, "客厅电视");
        assert_eq!(resolved.control_url, "http://192.168.1.5:49152/avt/control");
    }

    #[test]
    fn device_without_avtransport_is_rejected() {
        let xml = r#"<root><device><friendlyName>音箱</friendlyName></device></root>"#;

        let error =
            parse_device_description(xml, "http://192.168.1.6/desc.xml").expect_err("must reject");

        assert_eq!(error.code, "dlna_error");
    }

    #[test]
    fn private_ipv4_detection_covers_common_ranges() {
        assert!(is_private_ipv4(Ipv4Addr::new(192, 168, 1, 20)));
        assert!(is_private_ipv4(Ipv4Addr::new(10, 0, 0, 2)));
        assert!(is_private_ipv4(Ipv4Addr::new(172, 20, 0, 1)));
        assert!(!is_private_ipv4(Ipv4Addr::new(172, 33, 0, 1)));
        assert!(!is_private_ipv4(Ipv4Addr::new(8, 8, 8, 8)));
    }

    #[test]
    fn hls_manifest_children_are_rewritten_through_the_relay() {
        let manifest = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p.m3u8\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\nhttps://cdn.example/live/seg-1.ts\n";
        let base = "http://cdn.example/live/index.m3u8";
        let rewritten = rewrite_hls_manifest(manifest, base, "tok");

        assert!(rewritten.contains("/stream?url="), "{rewritten}");
        assert!(rewritten.contains("token=tok"));
        // 相对子清单与相对 key 都要解析成绝对地址后再编码进中继参数。
        assert!(
            rewritten.contains("cdn%2Eexample%2Flive%2F720p%2Em3u8"),
            "{rewritten}"
        );
        assert!(
            rewritten.contains("cdn%2Eexample%2Flive%2Fkey%2Ebin"),
            "{rewritten}"
        );
        assert!(rewritten.contains("seg%2D1%2Ets"), "{rewritten}");
    }

    #[test]
    fn loopback_targets_are_denied() {
        assert!(is_loopback_target("http://127.0.0.1:8080/x"));
        assert!(is_loopback_target("http://LOCALHOST/y"));
        assert!(!is_loopback_target("http://cdn.example/z"));
    }

    /// 端到端验证：模拟 DLNA 电视（设备描述 + SOAP 端点）与媒体源，
    /// 走完 cast 的完整链路——设备描述解析、SetAVTransportURI/Play 下发、
    /// 中继回源携带投屏 headers、令牌拦截与断开时的 Stop。
    #[tokio::test]
    async fn cast_end_to_end_against_a_mock_renderer() {
        if lan_ipv4().is_err() {
            // 没有可用局域网 IPv4 的环境无法构造中继地址。
            return;
        }

        let recorded: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

        // ---- 模拟渲染器：设备描述 + SOAP 控制端点 ----
        let renderer = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let renderer_addr = renderer.local_addr().unwrap().to_string();
        let device_description = "<?xml version=\"1.0\"?>\
<root xmlns=\"urn:schemas-upnp-org:device-1-0\"><specVersion><major>1</major><minor>0</minor></specVersion>\
<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>\
<friendlyName>客厅电视</friendlyName><serviceList><service>\
<serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\
<controlURL>/control</controlURL></service></serviceList></device></root>";
        let recorded_renderer = Arc::clone(&recorded);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = renderer.accept().await else {
                    break;
                };
                let recorded = Arc::clone(&recorded_renderer);
                tokio::spawn(async move {
                    let Some(request) = read_http_request(&mut socket).await else {
                        return;
                    };
                    let is_description = request.starts_with("GET /desc.xml");
                    recorded.lock().unwrap().push(request);
                    let body: Vec<u8> = if is_description {
                        device_description.as_bytes().to_vec()
                    } else {
                        // SOAP 成功应答；不能包含 "UPnPError"。
                        br#"{\"s:Envelope\":{}}"#.to_vec()
                    };
                    let content_type = if is_description {
                        "text/xml"
                    } else {
                        "text/xml; charset=\"utf-8\""
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        content_type,
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.flush().await;
                });
            }
        });

        // ---- 模拟媒体源：固定 FLV 字节，校验投屏 headers 注入 ----
        // 绑定到局域网地址而非回环：中继会拒绝回环上游，真实场景中媒体
        // 源也在本机之外。
        let origin_ip = match lan_ipv4().unwrap() {
            IpAddr::V4(ip) => ip,
            IpAddr::V6(_) => return,
        };
        let origin = TcpListener::bind(std::net::SocketAddr::new(IpAddr::V4(origin_ip), 0))
            .await
            .unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let recorded_origin = Arc::clone(&recorded);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = origin.accept().await else {
                    break;
                };
                let recorded = Arc::clone(&recorded_origin);
                tokio::spawn(async move {
                    let Some(request) = read_http_request(&mut socket).await else {
                        return;
                    };
                    recorded.lock().unwrap().push(request);
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/x-flv\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        b"FLV-BYTES-0123456789".len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(b"FLV-BYTES-0123456789").await;
                    let _ = socket.flush().await;
                });
            }
        });

        let manager = DlnaManager::new();
        let status = manager
            .cast(
                format!("http://{renderer_addr}/desc.xml"),
                format!("http://{origin_ip}:{origin_port}/live.flv"),
                [("referer".into(), "https://live.example/room".into())]
                    .into_iter()
                    .collect(),
                "测试直播".into(),
            )
            .await
            .expect("cast should succeed against the mock renderer");
        assert_eq!(status.device_name, "客厅电视");

        // 设备描述被拉取，且两条 SOAP 指令都到达控制端点。
        let requests = recorded.lock().unwrap().clone();
        assert!(
            requests
                .iter()
                .any(|request| request.contains("GET /desc.xml"))
        );
        assert!(
            requests
                .iter()
                .any(|request| request.contains("#SetAVTransportURI"))
        );
        assert!(requests.iter().any(|request| request.contains("#Play")));

        // 从 SetAVTransportURI 提取下发给电视的中继地址并实际访问。
        let set_uri_request = requests
            .iter()
            .find(|request| request.contains("#SetAVTransportURI"))
            .expect("set uri request");
        let current_uri = Regex::new(r"<CurrentURI>([^<]+)</CurrentURI>")
            .unwrap()
            .captures(set_uri_request)
            .map(|captures| captures[1].to_string())
            .expect("current uri in soap body")
            // SOAP 正文中的 XML 转义由接收方（电视）还原。
            .replace("&amp;", "&");
        assert!(current_uri.starts_with("http://"), "{current_uri}");
        assert!(current_uri.contains("/stream?url="), "{current_uri}");

        // 经中继取流：内容来自媒体源，且上游请求带上了登记的 referer。
        // 测试客户端同样必须绕过系统代理，避免环境变量干扰断言。
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client.get(&current_uri).send().await.expect("relay fetch");
        let status = response.status();
        let body = response.bytes().await.unwrap_or_default();
        assert_eq!(
            status,
            200,
            "relay said: {}",
            String::from_utf8_lossy(&body)
        );
        assert_eq!(body.as_ref(), b"FLV-BYTES-0123456789");
        let origin_requests = recorded.lock().unwrap().clone();
        assert!(origin_requests.iter().any(|request| {
            request.contains("GET /live.flv")
                && request.contains("referer: https://live.example/room")
        }));

        // 错误令牌必须被拒绝。
        let tampered = current_uri.replacen("token=", "token=wrong", 1);
        let denied = client.get(&tampered).send().await.expect("denied fetch");
        assert_eq!(denied.status(), 403);

        // 断开后电视收到 Stop。
        manager.stop().await.unwrap();
        let requests = recorded.lock().unwrap().clone();
        assert!(requests.iter().any(|request| request.contains("#Stop")));
    }

    /// 读取一条完整 HTTP 请求（头 + Content-Length 正文）。
    async fn read_http_request(socket: &mut TcpStream) -> Option<String> {
        let mut buffer = Vec::with_capacity(1024);
        let mut byte = [0_u8; 1];
        loop {
            match socket.read(&mut byte).await {
                Ok(1) => buffer.push(byte[0]),
                _ => return None,
            }
            if buffer.ends_with(b"\r\n\r\n") || buffer.ends_with(b"\n\n") {
                break;
            }
            if buffer.len() > 16_384 {
                return None;
            }
        }
        let head_end = buffer
            .windows(4)
            .rposition(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
            .unwrap_or(buffer.len());
        let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
        let content_length = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.trim()
                    .eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())?
            })
            .unwrap_or(0);
        let mut body = buffer[head_end.min(buffer.len())..].to_vec();
        while body.len() < content_length {
            match socket.read(&mut byte).await {
                Ok(1) => body.push(byte[0]),
                _ => break,
            }
        }
        Some(format!("{}{}", head, String::from_utf8_lossy(&body)))
    }
}
