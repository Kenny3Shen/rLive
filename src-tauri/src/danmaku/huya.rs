//! Huya danmaku — TARS binary over WebSocket (simple_live `HuyaDanmaku`).
//!
//! WS: `wss://cdnws.api.huya.com`
//! Join packet encodes ayyuid + channel ids; chat push uri=1400.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::time;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::danmaku::tars::{TarsReader, TarsWriter};
use crate::danmaku::{DanmakuEventSender, emit_event};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};

const SERVER_URL: &str = "wss://cdnws.api.huya.com";
const HEARTBEAT_SECS: u64 = 60;
/// simple_live heartbeat payload: base64 `ABQdAAwsNgBM`
const HEARTBEAT_B64: &str = "ABQdAAwsNgBM";

#[derive(Debug, Clone)]
pub struct HuyaDanmakuArgs {
    pub ayyuid: i64,
    pub top_sid: i64,
    pub sub_sid: i64,
}

fn json_i64(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().map(|u| u as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

pub fn args_from_raw(room_id: &str, raw: &Value) -> AppResult<HuyaDanmakuArgs> {
    let ayyuid = raw
        .get("ayyuid")
        .and_then(json_i64)
        .or_else(|| raw.get("lYyid").and_then(json_i64))
        .unwrap_or(0);
    let mut top_sid = raw.get("topSid").and_then(json_i64).unwrap_or(0);
    let mut sub_sid = raw.get("subSid").and_then(json_i64).unwrap_or(0);

    // Fallback: first stream line presenter uid
    if top_sid == 0 {
        if let Some(lines) = raw.get("lines").and_then(|v| v.as_array()) {
            for line in lines {
                if let Some(p) = line.get("presenterUid").and_then(json_i64) {
                    if p > 0 {
                        top_sid = p;
                        break;
                    }
                }
            }
        }
    }
    if sub_sid == 0 {
        sub_sid = top_sid;
    }
    // Last resort: try parse room_id as numeric channel
    if top_sid == 0 {
        if let Ok(n) = room_id.parse::<i64>() {
            top_sid = n;
            sub_sid = n;
        }
    }

    if ayyuid == 0 && top_sid == 0 {
        return Err(AppError::new(
            "danmaku_bad_room",
            "huya danmaku missing ayyuid/topSid (room raw incomplete)",
        )
        .with_site("huya"));
    }

    Ok(HuyaDanmakuArgs {
        ayyuid: if ayyuid != 0 { ayyuid } else { top_sid },
        top_sid,
        sub_sid,
    })
}

/// Build WS join packet (wscmd type=1 + UserInfo body).
pub fn encode_join(ayyuid: i64, tid: i64, sid: i64) -> Vec<u8> {
    let mut inner = TarsWriter::new();
    inner.write_i64(ayyuid, 0);
    inner.write_bool(true, 1);
    inner.write_string("", 2);
    inner.write_string("", 3);
    inner.write_i64(tid, 4);
    inner.write_i64(sid, 5);
    inner.write_i64(0, 6);
    inner.write_i64(0, 7);
    let body = inner.into_bytes();

    let mut outer = TarsWriter::new();
    outer.write_i64(1, 0);
    outer.write_bytes(&body, 1);
    outer.into_bytes()
}

pub fn heartbeat_bytes() -> Vec<u8> {
    base64_decode(HEARTBEAT_B64)
        .unwrap_or_else(|| vec![0x00, 0x14, 0x1d, 0x00, 0x0c, 0x2c, 0x36, 0x00, 0x4c])
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut inv = [255u8; 256];
    for (i, &c) in T.iter().enumerate() {
        inv[c as usize] = i as u8;
    }
    let s: Vec<u8> = s
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        let mut n = 0u32;
        let mut bits = 0;
        for &c in chunk {
            let v = inv[c as usize];
            if v == 255 {
                return None;
            }
            n = (n << 6) | u32::from(v);
            bits += 6;
        }
        while bits >= 8 {
            bits -= 8;
            out.push((n >> bits) as u8);
            n &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn color_hex(font_color: i64) -> Option<String> {
    if font_color <= 0 {
        return None;
    }
    Some(format!("#{:06x}", font_color as u32 & 0x00ff_ffff))
}

/// Decode one WS binary frame directly into a caller-owned sink.
///
/// A Huya push contains at most one chat event. Streaming it avoids creating
/// an empty temporary vector for online-count/control frames and lets the
/// TARS envelope borrow nested byte lists from the websocket buffer.
fn decode_message_with(data: &[u8], emit: &mut impl FnMut(DanmakuEvent)) {
    let mut stream = TarsReader::new(data);
    let msg_type = match stream.read_i64(0, false) {
        Ok(v) => v,
        Err(_) => return,
    };
    // type == 7 → push message
    if msg_type != 7 {
        return;
    }
    let push_bytes = match stream.read_bytes_cow(1, false) {
        Ok(b) if !b.is_empty() => b,
        _ => return,
    };
    let mut push = TarsReader::new(push_bytes.as_ref());
    // HYPushMessage: pushType@0, uri@1, msg@2, protocolType@3
    let _push_type = push.read_i64(0, false).unwrap_or(0);
    let uri = push.read_i64(1, false).unwrap_or(0);
    let msg = match push.read_bytes_cow(2, false) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => return,
    };
    // uri 8006 = online count — ignored for now (no dedicated event kind)
    if uri != 1400 {
        return;
    }

    // HYMessage: userInfo@0, content@3, bulletFormat@6
    let mut notice = TarsReader::new(msg.as_ref());
    let mut nick = String::new();
    if notice.read_struct_begin(0, false).unwrap_or(false) {
        // HYSender: uid@0, lMid@0 (ignored), nickName@2, gender@3
        let _uid = notice.read_i64(0, false).unwrap_or(0);
        nick = notice.read_string(2, false).unwrap_or_default();
        let _ = notice.read_struct_end();
    }
    let content = notice.read_string(3, false).unwrap_or_default();
    if content.is_empty() {
        return;
    }
    let mut font_color = 0i64;
    if notice.read_struct_begin(6, false).unwrap_or(false) {
        font_color = notice.read_i64(0, false).unwrap_or(0);
        let _ = notice.read_struct_end();
    }
    emit(DanmakuEvent {
        kind: DanmakuKind::Chat,
        user: if nick.is_empty() {
            "用户".into()
        } else {
            nick
        },
        content,
        color: color_hex(font_color),
        super_chat: None,
        ts: chrono::Utc::now().timestamp_millis(),
    });
}

#[cfg(test)]
fn decode_message(data: &[u8]) -> Vec<DanmakuEvent> {
    let mut events = Vec::new();
    decode_message_with(data, &mut |event| events.push(event));
    events
}

pub async fn run_loop(events: DanmakuEventSender, args: HuyaDanmakuArgs) -> AppResult<()> {
    emit_event(
        &events,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: format!(
                "正在连接弹幕服务器… ayyuid={} topSid={}",
                args.ayyuid, args.top_sid
            ),
            color: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );

    let (ws, _) = connect_async(SERVER_URL).await.map_err(|e| {
        AppError::new("danmaku_ws_error", format!("huya connect failed: {e}"))
            .with_site("huya")
            .retryable()
    })?;
    let (mut write, mut read) = ws.split();

    // simple_live uses topSid for both tid and sid in join
    let tid = if args.top_sid != 0 {
        args.top_sid
    } else {
        args.sub_sid
    };
    let sid = tid;
    let join = encode_join(args.ayyuid, tid, sid);
    write
        .send(Message::Binary(join.into()))
        .await
        .map_err(|e| {
            AppError::new("danmaku_ws_error", format!("huya join send: {e}")).with_site("huya")
        })?;

    emit_event(
        &events,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: "弹幕服务器连接成功".into(),
            color: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );

    let hb_payload = heartbeat_bytes();
    let mut heartbeat = time::interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await;
    let mut msg_count: u64 = 0;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if write.send(Message::Binary(hb_payload.clone().into())).await.is_err() {
                    break;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(bin))) => {
                        decode_message_with(&bin, &mut |ev| {
                            msg_count += 1;
                            emit_event(&events, ev);
                        });
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        tracing::warn!(error = %e, msgs = msg_count, "huya danmaku read error");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    emit_event(
        &events,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: format!("弹幕连接结束（已收 {msg_count} 条）"),
            color: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_packet_non_empty() {
        let p = encode_join(1_346_609_715, 1_346_609_715, 1_346_609_715);
        assert!(p.len() > 10);
        // Outer type tag 0 = 1
        let mut r = TarsReader::new(&p);
        assert_eq!(r.read_i64(0, true).unwrap(), 1);
        let body = r.read_bytes(1, true).unwrap();
        assert!(!body.is_empty());
    }

    #[test]
    fn heartbeat_matches_simple_live() {
        let hb = heartbeat_bytes();
        assert_eq!(hb, base64_decode(HEARTBEAT_B64).unwrap());
    }

    #[test]
    fn args_from_raw_reads_fields() {
        let raw = serde_json::json!({
            "ayyuid": 1486578378,
            "topSid": 1346609715,
            "subSid": 1346609715,
        });
        let a = args_from_raw("lpl", &raw).unwrap();
        assert_eq!(a.ayyuid, 1486578378);
        assert_eq!(a.top_sid, 1346609715);
    }

    #[test]
    fn decode_empty_is_empty() {
        assert!(decode_message(&[]).is_empty());
        assert!(decode_message(&[0x0c]).is_empty()); // ZERO at tag0 → type 0
    }

    #[test]
    fn streaming_decoder_preserves_a_chat_push() {
        let mut notice = TarsWriter::new();
        notice.write_head(crate::danmaku::tars::ty::STRUCT_BEGIN, 0);
        notice.write_i64(42, 0);
        notice.write_string("虎牙观众", 2);
        notice.write_head(crate::danmaku::tars::ty::STRUCT_END, 0);
        notice.write_string("测试弹幕", 3);
        notice.write_head(crate::danmaku::tars::ty::STRUCT_BEGIN, 6);
        notice.write_i64(0x11_22_33, 0);
        notice.write_head(crate::danmaku::tars::ty::STRUCT_END, 0);
        let notice = notice.into_bytes();

        let mut push = TarsWriter::new();
        push.write_i64(0, 0);
        push.write_i64(1400, 1);
        push.write_bytes(&notice, 2);
        let push = push.into_bytes();

        let mut frame = TarsWriter::new();
        frame.write_i64(7, 0);
        frame.write_bytes(&push, 1);

        let events = decode_message(&frame.into_bytes());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].user, "虎牙观众");
        assert_eq!(events[0].content, "测试弹幕");
        assert_eq!(events[0].color.as_deref(), Some("#112233"));
    }
}
