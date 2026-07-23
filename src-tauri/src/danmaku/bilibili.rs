use std::io::Read;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tauri::AppHandle;
use tokio::time;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::danmaku::emit_event;
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};

#[derive(Debug, Clone)]
pub struct BilibiliDanmakuArgs {
    pub room_id: i64,
    pub token: String,
    pub buvid: String,
    pub server_host: String,
    /// Viewer mid (DedeUserID). Use 0 when anonymous.
    pub uid: i64,
    pub cookie: String,
}

/// Extract `key=value` from a cookie header string.
fn cookie_value(cookie: &str, key: &str) -> Option<String> {
    for part in cookie.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            if k.trim() == key {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

pub fn args_from_raw(room_id: &str, raw: &Value) -> AppResult<BilibiliDanmakuArgs> {
    let danmaku = raw.get("danmaku").cloned().unwrap_or(Value::Null);
    let token = danmaku
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cookie = danmaku
        .get("cookie")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut buvid = danmaku
        .get("buvid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if buvid.is_empty() {
        buvid = cookie_value(&cookie, "buvid3").unwrap_or_default();
    }
    let server_host = danmaku
        .get("server_host")
        .and_then(|v| v.as_str())
        .unwrap_or("broadcastlv.chat.bilibili.com")
        .to_string();

    // Join packet `uid` is the **viewer** mid, never the streamer's room uid.
    let uid = danmaku
        .get("viewer_uid")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            danmaku
                .get("viewer_uid")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
        })
        .or_else(|| cookie_value(&cookie, "DedeUserID")?.parse().ok())
        .unwrap_or(0);

    let room_id_i = raw
        .get("room_id")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            raw.get("room_id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
        })
        .or_else(|| room_id.parse().ok())
        .unwrap_or(0);

    Ok(BilibiliDanmakuArgs {
        room_id: room_id_i,
        token,
        buvid,
        server_host,
        uid,
        cookie,
    })
}

pub fn encode_packet(body: &[u8], operation: u32) -> Vec<u8> {
    let packet_len = (body.len() + 16) as u32;
    let mut buf = Vec::with_capacity(packet_len as usize);
    buf.extend_from_slice(&packet_len.to_be_bytes());
    buf.extend_from_slice(&16u16.to_be_bytes()); // header length
    buf.extend_from_slice(&0u16.to_be_bytes()); // protocol version (JSON for send)
    buf.extend_from_slice(&operation.to_be_bytes());
    buf.extend_from_slice(&1u32.to_be_bytes()); // sequence
    buf.extend_from_slice(body);
    buf
}

fn read_u16(data: &[u8], start: usize) -> Option<u16> {
    data.get(start..start + 2)
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
}

fn read_u32(data: &[u8], start: usize) -> Option<u32> {
    data.get(start..start + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn inflate_zlib(body: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::ZlibDecoder;
    let mut dec = ZlibDecoder::new(body);
    let mut out = Vec::new();
    if dec.read_to_end(&mut out).is_ok() && !out.is_empty() {
        Some(out)
    } else {
        None
    }
}

fn inflate_brotli(body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut reader = brotli::Decompressor::new(body, 4096);
    if reader.read_to_end(&mut out).is_ok() && !out.is_empty() {
        Some(out)
    } else {
        // Fallback: whole-buffer API when streaming decompress fails.
        out.clear();
        if brotli::BrotliDecompress(&mut std::io::Cursor::new(body), &mut out).is_ok() && !out.is_empty()
        {
            Some(out)
        } else {
            None
        }
    }
}

/// Parse one or more protocol packets; returns chat/superchat/enter/gift events.
pub fn decode_packets(data: &[u8]) -> Vec<DanmakuEvent> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    while offset + 16 <= data.len() {
        let packet_len = match read_u32(data, offset) {
            Some(n) if (n as usize) >= 16 => n as usize,
            _ => break,
        };
        if offset + packet_len > data.len() {
            break;
        }
        let protocol_version = read_u16(data, offset + 6).unwrap_or(0);
        let operation = read_u32(data, offset + 8).unwrap_or(0);
        let body = &data[offset + 16..offset + packet_len];
        offset += packet_len;

        match operation {
            // Heartbeat reply / popularity — ignore
            3 => {}
            // Auth reply — ignore (handled in run_loop)
            8 => {}
            // Notify / danmaku payload
            5 => {
                let payload = match protocol_version {
                    2 => match inflate_zlib(body) {
                        Some(v) => v,
                        None => continue,
                    },
                    3 => match inflate_brotli(body) {
                        Some(v) => v,
                        None => continue,
                    },
                    _ => body.to_vec(),
                };

                // Compressed frames expand into nested packets (headers + bodies).
                if protocol_version == 2 || protocol_version == 3 {
                    if payload.len() >= 16 {
                        let nested_len = read_u32(&payload, 0).unwrap_or(0) as usize;
                        if nested_len >= 16 && nested_len <= payload.len() {
                            out.extend(decode_packets(&payload));
                            continue;
                        }
                    }
                }
                out.extend(parse_notify_body(&payload));
            }
            _ => {}
        }
    }
    out
}

/// Whether this buffer looks like a server auth-ok packet (op=8).
pub fn packets_contain_auth_ok(data: &[u8]) -> bool {
    let mut offset = 0usize;
    while offset + 16 <= data.len() {
        let packet_len = match read_u32(data, offset) {
            Some(n) if (n as usize) >= 16 => n as usize,
            _ => break,
        };
        if offset + packet_len > data.len() {
            break;
        }
        let operation = read_u32(data, offset + 8).unwrap_or(0);
        if operation == 8 {
            return true;
        }
        offset += packet_len;
    }
    false
}

fn parse_notify_body(body: &[u8]) -> Vec<DanmakuEvent> {
    let text = String::from_utf8_lossy(body);
    let mut events = Vec::new();
    // One WS body may contain multiple JSON objects glued by control bytes.
    for part in text.split(|c: char| c.is_control()) {
        let part = part.trim();
        if part.len() > 2 && part.starts_with('{') {
            if let Some(ev) = parse_message_json(part) {
                events.push(ev);
            }
        }
    }
    // Fallback: whole body as single JSON
    if events.is_empty() {
        let trimmed = text.trim();
        if trimmed.starts_with('{') {
            if let Some(ev) = parse_message_json(trimmed) {
                events.push(ev);
            }
        }
    }
    events
}

fn json_stringish(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

pub fn parse_message_json(json_message: &str) -> Option<DanmakuEvent> {
    let obj: Value = serde_json::from_str(json_message).ok()?;
    let cmd = obj.get("cmd")?.as_str()?.to_string();
    // Newer cmds look like "DANMU_MSG:4:0:0:0"
    let cmd_base = cmd.split(':').next().unwrap_or(&cmd);
    let ts = chrono::Utc::now().timestamp_millis();

    if cmd_base == "DANMU_MSG" || cmd.contains("DANMU_MSG") {
        let info = obj.get("info")?.as_array()?;
        let message = info
            .get(1)
            .map(json_stringish)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                // Some variants nest text under info[0][15].extra JSON
                None
            })
            .unwrap_or_default();
        if message.is_empty() {
            return None;
        }
        let color_num = info
            .get(0)
            .and_then(|v| v.as_array())
            .and_then(|a| a.get(3))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let user = info
            .get(2)
            .and_then(|v| v.as_array())
            .and_then(|a| a.get(1))
            .map(json_stringish)
            .unwrap_or_else(|| "用户".into());
        let color = if color_num == 0 {
            None
        } else {
            Some(format!("#{:06x}", color_num & 0x00ff_ffff))
        };
        return Some(DanmakuEvent {
            kind: DanmakuKind::Chat,
            user,
            content: message,
            color,
            ts,
        });
    }

    if cmd_base == "SUPER_CHAT_MESSAGE" || cmd_base == "SUPER_CHAT_MESSAGE_JPN" {
        let data = obj.get("data")?;
        let user = data
            .pointer("/user_info/uname")
            .and_then(|v| v.as_str())
            .unwrap_or("SC")
            .to_string();
        let message = data
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if message.is_empty() {
            return None;
        }
        return Some(DanmakuEvent {
            kind: DanmakuKind::SuperChat,
            user,
            content: message,
            color: None,
            ts,
        });
    }

    if cmd_base == "INTERACT_WORD" {
        let data = obj.get("data")?;
        let user = data
            .get("uname")
            .and_then(|v| v.as_str())
            .unwrap_or("用户")
            .to_string();
        return Some(DanmakuEvent {
            kind: DanmakuKind::Enter,
            user: user.clone(),
            content: format!("{user} 进入直播间"),
            color: None,
            ts,
        });
    }

    if cmd_base == "SEND_GIFT" {
        let data = obj.get("data")?;
        let user = data
            .get("uname")
            .and_then(|v| v.as_str())
            .unwrap_or("用户")
            .to_string();
        let gift = data
            .get("giftName")
            .and_then(|v| v.as_str())
            .unwrap_or("礼物");
        let num = data.get("num").and_then(|v| v.as_i64()).unwrap_or(1);
        return Some(DanmakuEvent {
            kind: DanmakuKind::Gift,
            user,
            content: format!("投喂 {gift} x{num}"),
            color: None,
            ts,
        });
    }

    None
}

pub async fn run_loop(app: AppHandle, args: BilibiliDanmakuArgs) -> AppResult<()> {
    if args.room_id <= 0 {
        return Err(AppError::new("danmaku_bad_room", "invalid room id for danmaku")
            .with_site("bilibili"));
    }
    if args.token.is_empty() {
        return Err(AppError::new(
            "danmaku_missing_token",
            "弹幕 token 为空（请在设置中保存有效 B 站 Cookie）",
        )
        .with_site("bilibili"));
    }

    let url = format!("wss://{}/sub", args.server_host);
    emit_event(
        &app,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: format!(
                "正在连接弹幕服务器… room={} host={}",
                args.room_id, args.server_host
            ),
            color: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );

    let (ws, _) = connect_async(&url).await.map_err(|e| {
        AppError::new("danmaku_ws_error", format!("connect failed: {e}"))
            .with_site("bilibili")
            .retryable()
    })?;
    let (mut write, mut read) = ws.split();

    // Auth / join. `uid` must be viewer mid (or 0).
    let join_body = serde_json::json!({
        "uid": args.uid,
        "roomid": args.room_id,
        "protover": 3,
        "buvid": args.buvid,
        "platform": "web",
        "type": 2,
        "key": args.token,
    })
    .to_string();
    let join_pkt = encode_packet(join_body.as_bytes(), 7);
    write
        .send(Message::Binary(join_pkt.into()))
        .await
        .map_err(|e| AppError::new("danmaku_ws_error", format!("auth send: {e}")))?;

    let mut heartbeat = time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut auth_ok = false;
    let mut msg_count: u64 = 0;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = encode_packet(b"", 2);
                if write.send(Message::Binary(hb.into())).await.is_err() {
                    break;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(bin))) => {
                        if !auth_ok && packets_contain_auth_ok(&bin) {
                            auth_ok = true;
                            emit_event(
                                &app,
                                DanmakuEvent {
                                    kind: DanmakuKind::System,
                                    user: "system".into(),
                                    content: "弹幕服务器连接成功".into(),
                                    color: None,
                                    ts: chrono::Utc::now().timestamp_millis(),
                                },
                            );
                        }
                        let events = decode_packets(&bin);
                        if !events.is_empty() {
                            // First payload often arrives with/without op=8 frame.
                            if !auth_ok {
                                auth_ok = true;
                                emit_event(
                                    &app,
                                    DanmakuEvent {
                                        kind: DanmakuKind::System,
                                        user: "system".into(),
                                        content: "弹幕服务器连接成功".into(),
                                        color: None,
                                        ts: chrono::Utc::now().timestamp_millis(),
                                    },
                                );
                            }
                            for ev in events {
                                msg_count += 1;
                                emit_event(&app, ev);
                            }
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        let events = decode_packets(text.as_bytes());
                        for ev in events {
                            msg_count += 1;
                            emit_event(&app, ev);
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        tracing::warn!(error = %e, msgs = msg_count, "danmaku ws read error");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    emit_event(
        &app,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: format!("弹幕连接结束（已收 {msg_count} 条）"),
            color: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_packet_header() {
        let p = encode_packet(b"{}", 7);
        assert_eq!(p.len(), 18);
        let len = u32::from_be_bytes([p[0], p[1], p[2], p[3]]);
        assert_eq!(len, 18);
        let op = u32::from_be_bytes([p[8], p[9], p[10], p[11]]);
        assert_eq!(op, 7);
    }

    #[test]
    fn parse_danmu_msg() {
        let json = r#"{
          "cmd":"DANMU_MSG",
          "info":[[0,1,25,16777215], "hello world", [1, "alice", 0], [], [], [], 0]
        }"#;
        let ev = parse_message_json(json).unwrap();
        assert_eq!(ev.user, "alice");
        assert_eq!(ev.content, "hello world");
        matches!(ev.kind, DanmakuKind::Chat);
    }

    #[test]
    fn parse_danmu_msg_colon_cmd() {
        let json = r#"{"cmd":"DANMU_MSG:4:0:0:0","info":[[0,1,25,16777215],"hi",[1,"bob",0]]}"#;
        let ev = parse_message_json(json).unwrap();
        assert_eq!(ev.user, "bob");
        assert_eq!(ev.content, "hi");
    }

    #[test]
    fn parse_enter() {
        let json = r#"{"cmd":"INTERACT_WORD","data":{"uname":"访客"}}"#;
        let ev = parse_message_json(json).unwrap();
        assert!(ev.content.contains("进入"));
    }

    #[test]
    fn args_from_raw_uses_viewer_uid_not_streamer() {
        let raw = serde_json::json!({
            "room_id": 12345,
            "uid": "999999",
            "danmaku": {
                "token": "tok",
                "server_host": "broadcastlv.chat.bilibili.com",
                "buvid": "b3",
                "cookie": "DedeUserID=1732227; SESSDATA=x",
                "viewer_uid": 1732227
            }
        });
        let args = args_from_raw("12345", &raw).unwrap();
        assert_eq!(args.token, "tok");
        assert_eq!(args.room_id, 12345);
        assert_eq!(args.uid, 1732227);
    }

    #[test]
    fn cookie_value_parses() {
        let c = "a=1; DedeUserID=42; b=2";
        assert_eq!(cookie_value(c, "DedeUserID").as_deref(), Some("42"));
    }

    #[test]
    fn zlib_nested_packet_roundtrip() {
        // Build a nested op=5 JSON packet, zlib-compress as outer ver=2 body.
        let inner_json = br#"{"cmd":"DANMU_MSG","info":[[0,1,25,0],"nested",[1,"carol",0]]}"#;
        let inner = encode_packet(inner_json, 5);
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&inner).unwrap();
        let compressed = enc.finish().unwrap();

        // Outer packet: ver=2, op=5
        let mut outer = Vec::new();
        let packet_len = (compressed.len() + 16) as u32;
        outer.extend_from_slice(&packet_len.to_be_bytes());
        outer.extend_from_slice(&16u16.to_be_bytes());
        outer.extend_from_slice(&2u16.to_be_bytes());
        outer.extend_from_slice(&5u32.to_be_bytes());
        outer.extend_from_slice(&1u32.to_be_bytes());
        outer.extend_from_slice(&compressed);

        let events = decode_packets(&outer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].user, "carol");
        assert_eq!(events[0].content, "nested");
    }
}
