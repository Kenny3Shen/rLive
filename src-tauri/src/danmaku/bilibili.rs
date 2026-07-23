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
    pub uid: i64,
    pub cookie: String,
}

pub fn args_from_raw(room_id: &str, raw: &Value) -> AppResult<BilibiliDanmakuArgs> {
    let danmaku = raw.get("danmaku").cloned().unwrap_or(Value::Null);
    let token = danmaku
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let buvid = danmaku
        .get("buvid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let server_host = danmaku
        .get("server_host")
        .and_then(|v| v.as_str())
        .unwrap_or("broadcastlv.chat.bilibili.com")
        .to_string();
    let cookie = danmaku
        .get("cookie")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let uid = raw
        .get("uid")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .or_else(|| raw.get("uid").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let room_id_i = raw
        .get("room_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
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
    buf.extend_from_slice(&0u16.to_be_bytes()); // protocol version (JSON)
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

/// Parse one or more protocol packets; returns chat/superchat events.
pub fn decode_packets(data: &[u8]) -> Vec<DanmakuEvent> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    while offset + 16 <= data.len() {
        let packet_len = match read_u32(data, offset) {
            Some(n) if n as usize >= 16 => n as usize,
            _ => break,
        };
        if offset + packet_len > data.len() {
            break;
        }
        let protocol_version = read_u16(data, offset + 6).unwrap_or(0);
        let operation = read_u32(data, offset + 8).unwrap_or(0);
        let body = &data[offset + 16..offset + packet_len];
        offset += packet_len;

        if operation == 5 {
            let body = match protocol_version {
                2 => inflate_zlib(body),
                3 => inflate_brotli(body),
                _ => body.to_vec(),
            };
            // Nested compressed frames may contain multiple packets.
            if protocol_version == 2 || protocol_version == 3 {
                if body.len() >= 16 && read_u32(&body, 0).unwrap_or(0) as usize <= body.len() {
                    out.extend(decode_packets(&body));
                    continue;
                }
            }
            out.extend(parse_notify_body(&body));
        }
    }
    out
}

fn inflate_zlib(body: &[u8]) -> Vec<u8> {
    use flate2::read::ZlibDecoder;
    let mut dec = ZlibDecoder::new(body);
    let mut out = Vec::new();
    if dec.read_to_end(&mut out).is_ok() {
        out
    } else {
        body.to_vec()
    }
}

fn inflate_brotli(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut reader = brotli::Decompressor::new(body, 4096);
    if reader.read_to_end(&mut out).is_ok() {
        out
    } else {
        body.to_vec()
    }
}

fn parse_notify_body(body: &[u8]) -> Vec<DanmakuEvent> {
    let text = String::from_utf8_lossy(body);
    let mut events = Vec::new();
    // Split on control chars like upstream.
    for part in text.split(|c: char| c.is_control()) {
        let part = part.trim();
        if part.len() > 2 && part.starts_with('{') {
            if let Some(ev) = parse_message_json(part) {
                events.push(ev);
            }
        }
    }
    events
}

pub fn parse_message_json(json_message: &str) -> Option<DanmakuEvent> {
    let obj: Value = serde_json::from_str(json_message).ok()?;
    let cmd = obj.get("cmd")?.as_str()?.to_string();
    let ts = chrono::Utc::now().timestamp_millis();

    if cmd.contains("DANMU_MSG") {
        let info = obj.get("info")?.as_array()?;
        let message = info.get(1)?.as_str().unwrap_or("").to_string();
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
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
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

    if cmd == "SUPER_CHAT_MESSAGE" {
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
        return Some(DanmakuEvent {
            kind: DanmakuKind::SuperChat,
            user,
            content: message,
            color: None,
            ts,
        });
    }

    None
}

pub async fn run_loop(app: AppHandle, args: BilibiliDanmakuArgs) -> AppResult<()> {
    let url = format!("wss://{}/sub", args.server_host);
    let (ws, _) = connect_async(&url).await.map_err(|e| {
        AppError::new("danmaku_ws_error", format!("connect failed: {e}"))
            .with_site("bilibili")
            .retryable()
    })?;
    let (mut write, mut read) = ws.split();

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
    // skip first immediate tick burst
    heartbeat.tick().await;

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
                        for ev in decode_packets(&bin) {
                            emit_event(&app, ev);
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        for ev in decode_packets(text.as_bytes()) {
                            emit_event(&app, ev);
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
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
    fn args_from_raw_reads_nested() {
        let raw = serde_json::json!({
            "room_id": "123",
            "uid": "9",
            "danmaku": {
                "token": "tok",
                "server_host": "broadcastlv.chat.bilibili.com",
                "buvid": "b3",
                "cookie": "a=1"
            }
        });
        let args = args_from_raw("123", &raw).unwrap();
        assert_eq!(args.token, "tok");
        assert_eq!(args.room_id, 123);
        assert_eq!(args.uid, 9);
    }
}
