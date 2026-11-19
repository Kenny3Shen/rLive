//! AcFun 直播弹幕。
//!
//! AcFun Web 播放器连接快手直播中台的 `wss://link.xiatou.com/`。帧外层是
//! protobuf 头，内层使用 AES-128-CBC；注册使用访客 `acSecurity`，注册应答
//! 再下发会话密钥。这里只接收聊天和必要状态消息，发送入口仍保持未接入。

use std::io::Read;
use std::time::{Duration, Instant};

use aes::Aes128;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use cbc::cipher::{KeyIvInit, block_padding::Pkcs7};
use cipher::{BlockDecryptMut, BlockEncryptMut};
use flate2::read::GzDecoder;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::time;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{WebSocketStream, client_async_tls_with_config};
use uuid::Uuid;

use crate::danmu_rs::proxy::{ConnectProxy, PROXY_CONNECT_TIMEOUT, open_websocket_transport};
use crate::danmu_rs::reconnect::{Decision, DisconnectReason, ReconnectPolicy};
use crate::danmu_rs::{DanmakuEventSender, ProtoReader, ProtoValue, emit_event, emit_system};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};

const ENDPOINT: &str = "wss://link.xiatou.com/";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const ORIGIN: &str = "https://live.acfun.cn";
const MAGIC: u16 = 0xabcd;
const VERSION: u16 = 1;
const APP_ID: u64 = 13;
const REGISTER: &str = "Basic.Register";
const KEEP_ALIVE: &str = "Basic.KeepAlive";
const ROOM_COMMAND: &str = "Global.ZtLiveInteractive.CsCmd";
const MESSAGE_COMMAND: &str = "Push.ZtLiveInteractive.Message";
const ENTER_ROOM_ACK: &str = "ZtLiveCsEnterRoomAck";
const JOIN_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const HEARTBEATS_PER_KEEP_ALIVE: u64 = 5;
const MAX_DECOMPRESSED_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 500;
const MAX_NAME_CHARS: usize = 128;

#[derive(Clone)]
pub struct AcfunDanmakuArgs {
    room_id: String,
    live_id: String,
    user_id: u64,
    device_id: String,
    visitor_token: String,
    security: [u8; 16],
    tickets: Vec<String>,
    enter_room_attach: String,
}

pub fn args_from_raw(raw: &Value) -> AppResult<AcfunDanmakuArgs> {
    let field = |name: &str| {
        raw.get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let live_id = field("liveId");
    let room_id = field("roomId");
    let user_id = field("userId").parse::<u64>().unwrap_or(0);
    let device_id = field("deviceId");
    let visitor_token = field("visitorToken");
    let enter_room_attach = field("enterRoomAttach");
    let security = decode_security(&field("security")).ok_or_else(|| {
        AppError::new(
            "acfun_danmaku_credentials",
            "AcFun 弹幕会话缺少有效的加密密钥",
        )
        .with_site("acfun")
    })?;
    let tickets = raw
        .get("tickets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|ticket| !ticket.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if room_id.is_empty()
        || live_id.is_empty()
        || user_id == 0
        || device_id.is_empty()
        || visitor_token.is_empty()
        || tickets.is_empty()
    {
        return Err(AppError::new(
            "acfun_danmaku_credentials",
            "AcFun 弹幕会话缺少直播或访客票据，请重新进入直播间",
        )
        .with_site("acfun"));
    }
    Ok(AcfunDanmakuArgs {
        room_id,
        live_id,
        user_id,
        device_id,
        visitor_token,
        security,
        tickets,
        enter_room_attach,
    })
}

fn decode_security(value: &str) -> Option<[u8; 16]> {
    let decoded = STANDARD.decode(value.trim()).ok()?;
    decoded.as_slice().try_into().ok()
}

type AcfunWebSocket = WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<
        tokio::io::BufStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >,
>;

async fn connect_ws(route: &crate::proxy::ProxyRoute) -> AppResult<AcfunWebSocket> {
    let parsed = reqwest::Url::parse(ENDPOINT)
        .map_err(|error| AppError::new("acfun_danmaku_url", error.to_string()))?;
    let host = parsed.host_str().unwrap_or("link.xiatou.com").to_owned();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let proxy = ConnectProxy::from_route(route, &format!("{host}:{port}"), "acfun", "AcFun")?;
    let stream = open_websocket_transport(proxy.as_ref(), &host, port, None)
        .await
        .map_err(|message| {
            AppError::new(
                "acfun_danmaku_transport",
                format!("连接 AcFun 弹幕服务器失败：{message}"),
            )
            .with_site("acfun")
            .retryable()
        })?;
    let mut request = ENDPOINT.into_client_request().map_err(|error| {
        AppError::new(
            "acfun_danmaku_transport",
            format!("AcFun 弹幕握手请求无效：{error}"),
        )
        .with_site("acfun")
    })?;
    request
        .headers_mut()
        .insert("origin", HeaderValue::from_static(ORIGIN));
    request
        .headers_mut()
        .insert("user-agent", HeaderValue::from_static(UA));
    time::timeout(
        PROXY_CONNECT_TIMEOUT,
        client_async_tls_with_config(request, stream, None, None),
    )
    .await
    .map_err(|_| {
        AppError::new("acfun_danmaku_transport", "AcFun 弹幕 WebSocket 握手超时")
            .with_site("acfun")
            .retryable()
    })?
    .map(|(socket, _)| socket)
    .map_err(|error| {
        AppError::new(
            "acfun_danmaku_transport",
            format!("AcFun 弹幕 WebSocket 握手失败：{error}"),
        )
        .with_site("acfun")
        .retryable()
    })
}

pub async fn run_loop(
    events: DanmakuEventSender,
    mut args: AcfunDanmakuArgs,
    route: crate::proxy::ProxyRoute,
) -> AppResult<()> {
    let mut policy = ReconnectPolicy::with_defaults("acfun");
    let mut refresh_failures = 0u32;
    loop {
        let outcome = run_connection_once(&events, &args, &route).await;
        if outcome.refresh_credentials {
            match crate::sites::acfun::refresh_danmaku_raw(&args.room_id, &route).await {
                Ok(raw) => match args_from_raw(&raw) {
                    Ok(refreshed) => {
                        args = refreshed;
                        refresh_failures = 0;
                    }
                    Err(error) => {
                        refresh_failures = refresh_failures.saturating_add(1);
                        emit_system(
                            &events,
                            format!("AcFun 弹幕凭据刷新失败：{}", error.message),
                        );
                    }
                },
                Err(error) if error.code == "acfun_stream_unavailable" => {
                    emit_system(&events, error.message);
                    return Ok(());
                }
                Err(error) => {
                    refresh_failures = refresh_failures.saturating_add(1);
                    emit_system(
                        &events,
                        format!("AcFun 弹幕凭据刷新失败：{}", error.message),
                    );
                }
            }
            if refresh_failures >= 3 {
                emit_system(&events, "AcFun 弹幕连续刷新凭据失败，已停止自动重连");
                return Ok(());
            }
        }
        match policy.on_disconnect(outcome.reason) {
            Decision::Retry { delay, notice } => {
                emit_system(&events, notice);
                time::sleep(delay).await;
            }
            Decision::Stop { notice, .. } => {
                emit_system(&events, notice);
                return Ok(());
            }
        }
    }
}

#[derive(Default)]
struct Link {
    uid: u64,
    sequence: u64,
    instance_id: u64,
    heartbeat_sequence: u64,
    session_key: Option<[u8; 16]>,
}

impl Link {
    fn new(args: &AcfunDanmakuArgs) -> Self {
        Self {
            uid: args.user_id,
            sequence: 1,
            ..Self::default()
        }
    }

    fn take_sequence(&mut self) -> u64 {
        let sequence = self.sequence;
        self.sequence = self.sequence.saturating_add(1);
        sequence
    }
}

#[derive(Debug)]
struct Packet {
    command: String,
    sequence: u64,
    error_code: u64,
    payload: Vec<u8>,
}

#[derive(Default)]
struct Push {
    events: Vec<DanmakuEvent>,
    ticket_invalid: bool,
    status_changed: Option<u64>,
}

struct ConnectionOutcome {
    reason: DisconnectReason,
    refresh_credentials: bool,
}

impl ConnectionOutcome {
    fn disconnected(reason: DisconnectReason) -> Self {
        Self {
            reason,
            refresh_credentials: false,
        }
    }

    fn refresh(reason: DisconnectReason) -> Self {
        Self {
            reason,
            refresh_credentials: true,
        }
    }
}

async fn run_connection_once(
    events: &DanmakuEventSender,
    args: &AcfunDanmakuArgs,
    route: &crate::proxy::ProxyRoute,
) -> ConnectionOutcome {
    emit_system(events, "正在连接 AcFun 弹幕服务器…");
    let socket = match connect_ws(route).await {
        Ok(socket) => socket,
        Err(error) if error.code.contains("danmaku_proxy") => {
            return ConnectionOutcome::disconnected(DisconnectReason::fatal(error.message));
        }
        Err(error) => {
            return ConnectionOutcome::disconnected(DisconnectReason::transient(error.message));
        }
    };
    let connected_at = Instant::now();
    let (mut write, mut read) = socket.split();
    let mut link = Link::new(args);
    let mut ticket_index = 0usize;
    let mut joined = false;
    let mut heartbeat_count = 0u64;
    let mut messages = 0u64;
    if send_register(&mut write, &mut link, args).await.is_err() {
        return ConnectionOutcome::disconnected(DisconnectReason::transient(
            "发送 AcFun 弹幕注册请求失败",
        ));
    }
    let mut join_deadline = time::Instant::now() + JOIN_TIMEOUT;
    let mut heartbeat_interval = HEARTBEAT_INTERVAL;
    let mut heartbeat_deadline = time::Instant::now() + heartbeat_interval;

    loop {
        tokio::select! {
            _ = time::sleep_until(join_deadline), if !joined => {
                return ConnectionOutcome::refresh(DisconnectReason::transient(
                    "加入 AcFun 弹幕房间超时",
                ));
            }
            _ = time::sleep_until(heartbeat_deadline), if joined => {
                heartbeat_count = heartbeat_count.saturating_add(1);
                if heartbeat_count % HEARTBEATS_PER_KEEP_ALIVE == 0
                    && send_keep_alive(&mut write, &mut link, args).await.is_err()
                {
                    break;
                }
                if send_heartbeat(&mut write, &mut link, args, &args.tickets[ticket_index]).await.is_err() {
                    break;
                }
                heartbeat_deadline = time::Instant::now() + heartbeat_interval;
            }
            incoming = read.next() => {
                let message = match incoming {
                    Some(Ok(message)) => message,
                    Some(Err(error)) => {
                        tracing::warn!(error = %error, "acfun danmaku read error");
                        break;
                    }
                    None => break,
                };
                match message {
                    Message::Binary(bytes) => {
                        let packet = match read_packet(&bytes, &mut link, &args.security) {
                            Ok(packet) => packet,
                            Err(error) => {
                                tracing::warn!(%error, "acfun danmaku frame ignored");
                                continue;
                            }
                        };
                        if packet.error_code != 0 {
                            return ConnectionOutcome::refresh(DisconnectReason::transient(format!(
                                "AcFun 弹幕服务器拒绝请求（{}）",
                                packet.error_code
                            )));
                        }
                        match packet.command.as_str() {
                            REGISTER => {
                                if link.session_key.is_none()
                                    || send_keep_alive(&mut write, &mut link, args).await.is_err()
                                    || send_enter_room(
                                        &mut write,
                                        &mut link,
                                        args,
                                        &args.tickets[ticket_index],
                                        0,
                                    ).await.is_err()
                                {
                                    break;
                                }
                                join_deadline = time::Instant::now() + JOIN_TIMEOUT;
                            }
                            ROOM_COMMAND => {
                                let ack = decode_ack(&packet.payload);
                                match ack {
                                    Ok((kind, code, payload)) if code == 0 && kind == ENTER_ROOM_ACK && !joined => {
                                        joined = true;
                                        if let Some(interval) = heartbeat_interval_from_ack(&payload) {
                                            heartbeat_interval = interval;
                                        }
                                        heartbeat_deadline = time::Instant::now() + heartbeat_interval;
                                        emit_system(events, "AcFun 弹幕已连接");
                                    }
                                    Ok((_, code, _)) if matches!(code, 2 | 3 | 4 | 7) => {
                                        ticket_index += 1;
                                        if ticket_index >= args.tickets.len() {
                                            return ConnectionOutcome::refresh(DisconnectReason::transient(
                                                "AcFun 弹幕票据已全部失效",
                                            ));
                                        }
                                        if send_enter_room(
                                            &mut write,
                                            &mut link,
                                            args,
                                            &args.tickets[ticket_index],
                                            0,
                                        ).await.is_err() {
                                            break;
                                        }
                                    }
                                    Ok((_, code, _)) if code != 0 => {
                                        return ConnectionOutcome::refresh(DisconnectReason::transient(format!(
                                            "AcFun 弹幕房间命令失败（{code}）"
                                        )));
                                    }
                                    _ => {}
                                }
                            }
                            MESSAGE_COMMAND => {
                                if send_push_ack(&mut write, &link, &packet).await.is_err() {
                                    break;
                                }
                                let push = decode_push(&packet.payload);
                                messages = messages.saturating_add(push.events.len() as u64);
                                for event in push.events {
                                    emit_event(events, event);
                                }
                                if push.ticket_invalid {
                                    ticket_index += 1;
                                    if ticket_index >= args.tickets.len() {
                                        return ConnectionOutcome::refresh(DisconnectReason::transient(
                                            "AcFun 弹幕票据已全部失效",
                                        ));
                                    }
                                    joined = false;
                                    join_deadline = time::Instant::now() + JOIN_TIMEOUT;
                                    if send_enter_room(
                                        &mut write,
                                        &mut link,
                                        args,
                                        &args.tickets[ticket_index],
                                        0,
                                    ).await.is_err() {
                                        break;
                                    }
                                } else if matches!(push.status_changed, Some(1 | 2 | 4)) {
                                    return ConnectionOutcome::refresh(DisconnectReason::transient(
                                        "AcFun 直播状态已变化",
                                    ));
                                }
                            }
                            command if command.starts_with("Push.") => {
                                let _ = send_push_ack(&mut write, &link, &packet).await;
                            }
                            _ => {}
                        }
                    }
                    Message::Ping(payload) => {
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }
    ConnectionOutcome::disconnected(DisconnectReason::Dropped {
        messages,
        connected_for: connected_at.elapsed(),
        detail: None,
    })
}

async fn send_register<W>(write: &mut W, link: &mut Link, args: &AcfunDanmakuArgs) -> AppResult<()>
where
    W: futures_util::Sink<Message> + Unpin,
    W::Error: std::fmt::Display,
{
    let frame = encode_register(link, args)?;
    write
        .send(Message::Binary(frame.into()))
        .await
        .map_err(|error| AppError::new("acfun_danmaku_write", error.to_string()).with_site("acfun"))
}

async fn send_keep_alive<W>(
    write: &mut W,
    link: &mut Link,
    args: &AcfunDanmakuArgs,
) -> AppResult<()>
where
    W: futures_util::Sink<Message> + Unpin,
    W::Error: std::fmt::Display,
{
    let sequence = link.take_sequence();
    let frame = encode_command(link, args, KEEP_ALIVE, encode_keep_alive(), sequence)?;
    write
        .send(Message::Binary(frame.into()))
        .await
        .map_err(|error| AppError::new("acfun_danmaku_write", error.to_string()).with_site("acfun"))
}

async fn send_enter_room<W>(
    write: &mut W,
    link: &mut Link,
    args: &AcfunDanmakuArgs,
    ticket: &str,
    reconnects: u64,
) -> AppResult<()>
where
    W: futures_util::Sink<Message> + Unpin,
    W::Error: std::fmt::Display,
{
    let mut body = Vec::new();
    put_uint(1, 0, &mut body);
    put_uint(2, reconnects, &mut body);
    put_bytes(4, args.enter_room_attach.as_bytes(), &mut body);
    put_bytes(5, b"kwai-acfun-live-link", &mut body);
    let mut command = Vec::new();
    put_bytes(1, b"ZtLiveCsEnterRoom", &mut command);
    put_bytes(2, &body, &mut command);
    put_bytes(3, ticket.as_bytes(), &mut command);
    put_bytes(4, args.live_id.as_bytes(), &mut command);
    let sequence = link.take_sequence();
    let frame = encode_command(link, args, ROOM_COMMAND, command, sequence)?;
    write
        .send(Message::Binary(frame.into()))
        .await
        .map_err(|error| AppError::new("acfun_danmaku_write", error.to_string()).with_site("acfun"))
}

async fn send_heartbeat<W>(
    write: &mut W,
    link: &mut Link,
    args: &AcfunDanmakuArgs,
    ticket: &str,
) -> AppResult<()>
where
    W: futures_util::Sink<Message> + Unpin,
    W::Error: std::fmt::Display,
{
    let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let sequence = link.heartbeat_sequence;
    link.heartbeat_sequence = link.heartbeat_sequence.saturating_add(1);
    let mut body = Vec::new();
    put_uint(1, now, &mut body);
    put_uint(2, sequence, &mut body);
    let mut command = Vec::new();
    put_bytes(1, b"ZtLiveCsHeartbeat", &mut command);
    put_bytes(2, &body, &mut command);
    put_bytes(3, ticket.as_bytes(), &mut command);
    put_bytes(4, args.live_id.as_bytes(), &mut command);
    let sequence = link.take_sequence();
    let frame = encode_command(link, args, ROOM_COMMAND, command, sequence)?;
    write
        .send(Message::Binary(frame.into()))
        .await
        .map_err(|error| AppError::new("acfun_danmaku_write", error.to_string()).with_site("acfun"))
}

async fn send_push_ack<W>(write: &mut W, link: &Link, packet: &Packet) -> AppResult<()>
where
    W: futures_util::Sink<Message> + Unpin,
    W::Error: std::fmt::Display,
{
    let plain = encode_upstream(&packet.command, link.sequence, None);
    let frame = frame(
        &encode_header(link, 2, plain.len(), Some(packet.sequence)),
        &seal(&plain, session_key(link)?, &random_iv()),
    )?;
    write
        .send(Message::Binary(frame.into()))
        .await
        .map_err(|error| AppError::new("acfun_danmaku_write", error.to_string()).with_site("acfun"))
}

fn session_key(link: &Link) -> AppResult<[u8; 16]> {
    link.session_key
        .ok_or_else(|| AppError::new("acfun_danmaku_state", "AcFun 会话密钥尚未建立"))
}

fn encode_register(link: &mut Link, args: &AcfunDanmakuArgs) -> AppResult<Vec<u8>> {
    let mut app = Vec::new();
    put_bytes(1, b"link-sdk", &mut app);
    put_bytes(4, b"1.2.1", &mut app);
    let mut device = Vec::new();
    put_uint(1, 6, &mut device);
    put_bytes(3, b"h5", &mut device);
    put_bytes(5, args.device_id.as_bytes(), &mut device);
    let mut common = Vec::new();
    put_bytes(1, b"ACFUN_APP", &mut common);
    put_bytes(2, b"PC_WEB", &mut common);
    put_uint(4, args.user_id, &mut common);
    put_bytes(5, args.device_id.as_bytes(), &mut common);
    let mut body = Vec::new();
    put_bytes(1, &app, &mut body);
    put_bytes(2, &device, &mut body);
    put_uint(4, 1, &mut body);
    put_uint(5, 1, &mut body);
    put_uint(8, 0, &mut body);
    put_bytes(11, &common, &mut body);
    let sequence = link.take_sequence();
    let plain = encode_upstream(REGISTER, sequence, Some(&body));
    let token = encode_token(args);
    let header = encode_header_with_token(link, 1, plain.len(), token, sequence);
    Ok(frame(&header, &seal(&plain, args.security, &random_iv()))?)
}

fn encode_command(
    link: &Link,
    args: &AcfunDanmakuArgs,
    command: &str,
    body: Vec<u8>,
    sequence: u64,
) -> AppResult<Vec<u8>> {
    let plain = encode_upstream(command, sequence, Some(&body));
    let header = encode_header(link, 2, plain.len(), Some(sequence));
    let _ = args;
    Ok(frame(
        &header,
        &seal(&plain, session_key(link)?, &random_iv()),
    )?)
}

fn encode_upstream(command: &str, sequence: u64, body: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    put_bytes(1, command.as_bytes(), &mut out);
    put_uint(2, sequence, &mut out);
    put_uint(3, 1, &mut out);
    if let Some(body) = body {
        put_bytes(4, body, &mut out);
    }
    put_bytes(9, b"mainApp", &mut out);
    out
}

fn encode_keep_alive() -> Vec<u8> {
    let mut body = Vec::new();
    put_uint(1, 1, &mut body);
    put_uint(2, 1, &mut body);
    body
}

fn encode_token(args: &AcfunDanmakuArgs) -> Vec<u8> {
    let mut token = Vec::new();
    put_uint(1, 1, &mut token);
    put_bytes(2, args.visitor_token.as_bytes(), &mut token);
    token
}

fn encode_header(link: &Link, mode: u64, plain_len: usize, sequence: Option<u64>) -> Vec<u8> {
    encode_header_fields(
        link,
        mode,
        plain_len,
        sequence.unwrap_or(link.sequence),
        None,
    )
}

fn encode_header_with_token(
    link: &Link,
    mode: u64,
    plain_len: usize,
    token: Vec<u8>,
    sequence: u64,
) -> Vec<u8> {
    encode_header_fields(link, mode, plain_len, sequence, Some(token))
}

fn encode_header_fields(
    link: &Link,
    mode: u64,
    plain_len: usize,
    sequence: u64,
    token: Option<Vec<u8>>,
) -> Vec<u8> {
    let mut header = Vec::new();
    put_uint(1, APP_ID, &mut header);
    put_uint(2, link.uid, &mut header);
    put_uint(3, link.instance_id, &mut header);
    put_uint(7, plain_len as u64, &mut header);
    put_uint(8, mode, &mut header);
    if let Some(token) = token {
        put_bytes(9, &token, &mut header);
    }
    put_uint(10, sequence, &mut header);
    put_bytes(12, b"ACFUN_APP", &mut header);
    header
}

fn frame(header: &[u8], payload: &[u8]) -> AppResult<Vec<u8>> {
    let header_len = u32::try_from(header.len())
        .map_err(|_| AppError::new("acfun_danmaku_frame", "AcFun 弹幕头过大"))?;
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| AppError::new("acfun_danmaku_frame", "AcFun 弹幕负载过大"))?;
    let mut out = Vec::with_capacity(12 + header.len() + payload.len());
    out.extend_from_slice(&MAGIC.to_be_bytes());
    out.extend_from_slice(&VERSION.to_be_bytes());
    out.extend_from_slice(&header_len.to_be_bytes());
    out.extend_from_slice(&payload_len.to_be_bytes());
    out.extend_from_slice(header);
    out.extend_from_slice(payload);
    Ok(out)
}

fn unframe(bytes: &[u8]) -> AppResult<(&[u8], &[u8])> {
    if bytes.len() < 12 || u16::from_be_bytes([bytes[0], bytes[1]]) != MAGIC {
        return Err(AppError::new("acfun_danmaku_frame", "AcFun 弹幕帧无效"));
    }
    let header_len = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let payload_len = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let expected = 12usize
        .checked_add(header_len)
        .and_then(|value| value.checked_add(payload_len))
        .ok_or_else(|| AppError::new("acfun_danmaku_frame", "AcFun 弹幕帧长度溢出"))?;
    if expected != bytes.len() {
        return Err(AppError::new(
            "acfun_danmaku_frame",
            "AcFun 弹幕帧长度不匹配",
        ));
    }
    Ok((&bytes[12..12 + header_len], &bytes[12 + header_len..]))
}

fn seal(plain: &[u8], key: [u8; 16], iv: &[u8; 16]) -> Vec<u8> {
    let encrypted = cbc::Encryptor::<Aes128>::new(&key.into(), &(*iv).into())
        .encrypt_padded_vec_mut::<Pkcs7>(plain);
    let mut out = Vec::with_capacity(16 + encrypted.len());
    out.extend_from_slice(iv);
    out.extend_from_slice(&encrypted);
    out
}

fn unseal(sealed: &[u8], key: [u8; 16]) -> AppResult<Vec<u8>> {
    if sealed.len() < 32 || sealed.len() % 16 != 0 {
        return Err(AppError::new(
            "acfun_danmaku_crypto",
            "AcFun 弹幕密文长度无效",
        ));
    }
    let iv: [u8; 16] = sealed[..16]
        .try_into()
        .map_err(|_| AppError::new("acfun_danmaku_crypto", "AcFun 弹幕 IV 无效"))?;
    cbc::Decryptor::<Aes128>::new(&key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(&sealed[16..])
        .map_err(|_| AppError::new("acfun_danmaku_crypto", "AcFun 弹幕解密失败"))
}

fn random_iv() -> [u8; 16] {
    *Uuid::new_v4().as_bytes()
}

fn read_packet(bytes: &[u8], link: &mut Link, security: &[u8; 16]) -> AppResult<Packet> {
    let (header, payload) = unframe(bytes)?;
    let mut reader = ProtoReader::new(header);
    let mut mode = 0u64;
    let mut sequence = 0u64;
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|reason| AppError::new("acfun_danmaku_proto", reason))?
    {
        match (field, value) {
            (8, ProtoValue::Varint(value)) => mode = value,
            (10, ProtoValue::Varint(value)) => sequence = value,
            _ => {}
        }
    }
    let plain = match mode {
        0 => payload.to_vec(),
        1 => unseal(payload, *security)?,
        2 => unseal(payload, session_key(link)?)?,
        _ => {
            return Err(AppError::new(
                "acfun_danmaku_crypto",
                format!("AcFun 弹幕使用了未知加密模式 {mode}"),
            ));
        }
    };
    let packet = decode_downstream(&plain, sequence)?;
    if packet.command == REGISTER && packet.error_code == 0 {
        let mut answer = ProtoReader::new(&packet.payload);
        while let Some((field, value)) = answer
            .next_field()
            .map_err(|reason| AppError::new("acfun_danmaku_proto", reason))?
        {
            match (field, value) {
                (2, ProtoValue::Bytes(value)) if value.len() == 16 => {
                    link.session_key = Some(value.try_into().unwrap());
                }
                (3, ProtoValue::Varint(value)) => link.instance_id = value,
                _ => {}
            }
        }
    }
    Ok(packet)
}

fn decode_downstream(bytes: &[u8], header_sequence: u64) -> AppResult<Packet> {
    let mut reader = ProtoReader::new(bytes);
    let mut command = String::new();
    let mut sequence = header_sequence;
    let mut error_code = 0;
    let mut payload = Vec::new();
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|reason| AppError::new("acfun_danmaku_proto", reason))?
    {
        match (field, value) {
            (1, ProtoValue::Bytes(value)) => {
                command = String::from_utf8_lossy(value).into_owned();
            }
            (2, ProtoValue::Varint(value)) => sequence = value,
            (3, ProtoValue::Varint(value)) => error_code = value,
            (4, ProtoValue::Bytes(value)) => payload = value.to_vec(),
            _ => {}
        }
    }
    Ok(Packet {
        command,
        sequence,
        error_code,
        payload,
    })
}

fn decode_ack(bytes: &[u8]) -> AppResult<(String, u64, Vec<u8>)> {
    let mut reader = ProtoReader::new(bytes);
    let mut kind = String::new();
    let mut code = 0;
    let mut payload = Vec::new();
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|reason| AppError::new("acfun_danmaku_proto", reason))?
    {
        match (field, value) {
            (1, ProtoValue::Bytes(value)) => kind = String::from_utf8_lossy(value).into_owned(),
            (2, ProtoValue::Varint(value)) => code = value,
            (4, ProtoValue::Bytes(value)) => payload = value.to_vec(),
            _ => {}
        }
    }
    Ok((kind, code, payload))
}

fn heartbeat_interval_from_ack(bytes: &[u8]) -> Option<Duration> {
    let mut reader = ProtoReader::new(bytes);
    while let Ok(Some((field, value))) = reader.next_field() {
        if let (1, ProtoValue::Varint(millis)) = (field, value)
            && (1_000..=60_000).contains(&millis)
        {
            return Some(Duration::from_millis(millis));
        }
    }
    None
}

fn decode_push(bytes: &[u8]) -> Push {
    let push = Push::default();
    let Ok((kind, compression, body)) = decode_sc_message(bytes) else {
        return push;
    };
    if compression == 2 {
        let decoder = GzDecoder::new(body);
        let mut limited = decoder.take(MAX_DECOMPRESSED_BYTES + 1);
        let mut unpacked = Vec::new();
        if limited.read_to_end(&mut unpacked).is_err()
            || unpacked.len() as u64 > MAX_DECOMPRESSED_BYTES
        {
            return push;
        }
        return decode_push_kind(&kind, &unpacked);
    }
    decode_push_kind(&kind, body)
}

fn decode_sc_message(bytes: &[u8]) -> AppResult<(String, u64, &[u8])> {
    let mut reader = ProtoReader::new(bytes);
    let mut kind = String::new();
    let mut compression = 0;
    let mut body = &[][..];
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|reason| AppError::new("acfun_danmaku_proto", reason))?
    {
        match (field, value) {
            (1, ProtoValue::Bytes(value)) => kind = String::from_utf8_lossy(value).into_owned(),
            (2, ProtoValue::Varint(value)) => compression = value,
            (3, ProtoValue::Bytes(value)) => body = value,
            _ => {}
        }
    }
    Ok((kind, compression, body))
}

fn decode_push_kind(kind: &str, body: &[u8]) -> Push {
    let mut push = Push::default();
    match kind {
        "ZtLiveScActionSignal" => {
            let Ok(signals) = repeated_messages(body, 1) else {
                return push;
            };
            for signal in signals {
                let Ok((signal_kind, payloads)) = action_signal(&signal) else {
                    continue;
                };
                if signal_kind != "CommonActionSignalComment" {
                    continue;
                }
                for payload in payloads {
                    if let Some(event) = decode_comment(&payload) {
                        push.events.push(event);
                    }
                }
            }
        }
        "ZtLiveScTicketInvalid" => push.ticket_invalid = true,
        "ZtLiveScStatusChanged" => {
            let mut reader = ProtoReader::new(body);
            if let Ok(Some((1, ProtoValue::Varint(value)))) = reader.next_field() {
                push.status_changed = Some(value);
            }
        }
        _ => {}
    }
    push
}

fn repeated_messages<'a>(bytes: &'a [u8], wanted: u32) -> AppResult<Vec<&'a [u8]>> {
    let mut reader = ProtoReader::new(bytes);
    let mut values = Vec::new();
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|reason| AppError::new("acfun_danmaku_proto", reason))?
    {
        if let (true, ProtoValue::Bytes(value)) = (field == wanted, value) {
            values.push(value);
        }
    }
    Ok(values)
}

fn action_signal(bytes: &[u8]) -> AppResult<(String, Vec<Vec<u8>>)> {
    let mut reader = ProtoReader::new(bytes);
    let mut kind = String::new();
    let mut payloads = Vec::new();
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|reason| AppError::new("acfun_danmaku_proto", reason))?
    {
        match (field, value) {
            (1, ProtoValue::Bytes(value)) => kind = String::from_utf8_lossy(value).into_owned(),
            (2, ProtoValue::Bytes(value)) => payloads.push(value.to_vec()),
            _ => {}
        }
    }
    Ok((kind, payloads))
}

fn decode_comment(bytes: &[u8]) -> Option<DanmakuEvent> {
    let mut reader = ProtoReader::new(bytes);
    let mut content = String::new();
    let mut sent_at = 0u64;
    let mut user_id = None;
    let mut user = String::new();
    while let Ok(Some((field, value))) = reader.next_field() {
        match (field, value) {
            (1, ProtoValue::Bytes(value)) => content = bounded_text(value, MAX_TEXT_CHARS),
            (2, ProtoValue::Varint(value)) => sent_at = value,
            (3, ProtoValue::Bytes(value)) => {
                let mut user_reader = ProtoReader::new(value);
                while let Ok(Some((user_field, user_value))) = user_reader.next_field() {
                    match (user_field, user_value) {
                        (1, ProtoValue::Varint(id)) if id > 0 => user_id = Some(id.to_string()),
                        (2, ProtoValue::Bytes(value)) => {
                            user = bounded_text(value, MAX_NAME_CHARS);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    content = content.trim().to_owned();
    if content.is_empty() {
        return None;
    }
    Some(DanmakuEvent {
        kind: DanmakuKind::Chat,
        user: if user.trim().is_empty() {
            "用户".into()
        } else {
            user
        },
        is_self: false,
        user_id,
        content,
        color: None,
        spans: None,
        super_chat: None,
        ts: if sent_at > 0 {
            i64::try_from(sent_at).unwrap_or_else(|_| chrono::Utc::now().timestamp_millis())
        } else {
            chrono::Utc::now().timestamp_millis()
        },
    })
}

fn bounded_text(bytes: &[u8], max_chars: usize) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .take(max_chars)
        .collect()
}

fn put_varint(mut value: u64, out: &mut Vec<u8>) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn put_uint(field: u32, value: u64, out: &mut Vec<u8>) {
    put_varint(u64::from(field << 3), out);
    put_varint(value, out);
}

fn put_bytes(field: u32, value: &[u8], out: &mut Vec<u8>) {
    put_varint(u64::from(field << 3 | 2), out);
    put_varint(value.len() as u64, out);
    out.extend_from_slice(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};

    fn args() -> AcfunDanmakuArgs {
        AcfunDanmakuArgs {
            room_id: "42".into(),
            live_id: "live".into(),
            user_id: 42,
            device_id: "web_device".into(),
            visitor_token: "visitor-token".into(),
            security: [7; 16],
            tickets: vec!["ticket-a".into(), "ticket-b".into()],
            enter_room_attach: "attach".into(),
        }
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn parses_args_and_rejects_missing_tickets() {
        let raw = serde_json::json!({
            "roomId": "42",
            "liveId": "live",
            "userId": "42",
            "deviceId": "web_device",
            "visitorToken": "visitor-token",
            "security": "BwcHBwcHBwcHBwcHBwcHBw==",
            "tickets": ["ticket-a"],
            "enterRoomAttach": "attach",
        });
        let args = args_from_raw(&raw).unwrap();
        assert_eq!(args.user_id, 42);
        assert_eq!(args.security, [7; 16]);
        let mut missing = raw;
        missing["tickets"] = serde_json::json!([]);
        assert_eq!(
            args_from_raw(&missing).err().unwrap().code,
            "acfun_danmaku_credentials"
        );
    }

    #[test]
    fn encrypted_register_frame_round_trips() {
        let args = args();
        let frame = encode_register(&mut Link::new(&args), &args).unwrap();
        let (header, payload) = unframe(&frame).unwrap();
        assert_eq!(&frame[..4], &[0xab, 0xcd, 0, 1]);
        assert!(!header.is_empty());
        let plain = unseal(payload, args.security).unwrap();
        let packet = decode_downstream(&plain, 1).unwrap();
        assert_eq!(packet.command, REGISTER);
        assert!(!packet.payload.is_empty());
    }

    #[test]
    fn decodes_gzipped_acfun_chat() {
        let mut user = Vec::new();
        put_uint(1, 42, &mut user);
        put_bytes(2, "AC娘".as_bytes(), &mut user);
        let mut comment = Vec::new();
        put_bytes(1, "你好，AcFun！".as_bytes(), &mut comment);
        put_uint(2, 1_704_067_200_000, &mut comment);
        put_bytes(3, &user, &mut comment);
        let mut signal = Vec::new();
        put_bytes(1, b"CommonActionSignalComment", &mut signal);
        put_bytes(2, &comment, &mut signal);
        let mut actions = Vec::new();
        put_bytes(1, &signal, &mut actions);
        let packed = gzip(&actions);
        let mut sc = Vec::new();
        put_bytes(1, b"ZtLiveScActionSignal", &mut sc);
        put_uint(2, 2, &mut sc);
        put_bytes(3, &packed, &mut sc);
        let push = decode_push(&sc);
        assert_eq!(push.events.len(), 1);
        assert_eq!(push.events[0].user, "AC娘");
        assert_eq!(push.events[0].content, "你好，AcFun！");
        assert_eq!(push.events[0].ts, 1_704_067_200_000);
    }
}
