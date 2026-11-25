//! YouTube 公开网页直播聊天。
//!
//! 匿名观看页仍会下发 `liveChatRenderer` continuation。这里复用网页自身的
//! `youtubei/v1/live_chat/get_live_chat` 轮询协议，不依赖 API key、OAuth、
//! Cookie 或额外的 yt-dlp 进程。网页接口没有稳定兼容性承诺，因此所有响应都按
//! 不可信 JSON 校验，失败时使用固定提示并交给共享重连策略。

use std::collections::{HashSet, VecDeque};
use std::convert::Infallible;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::time;

use crate::danmu_rs::reconnect::{Decision, DisconnectReason, ReconnectPolicy};
use crate::danmu_rs::{DanmakuEventSender, emit_event, emit_system};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind, SuperChatInfo};

const LIVE_CHAT_API: &str =
    "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_CLIENT_VERSION: &str = "2.20260101.00.00";
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(10);
const MAX_MESSAGE_ID_BYTES: usize = 2_048;
/// continuation 是继续游标，不与 renderer 消息 ID 共用长度上限。
const MAX_CONTINUATION_BYTES: usize = 16 * 1_024;
const MAX_SEEN_MESSAGES: usize = 4_096;
const MAX_USER_CHARS: usize = 128;
const MAX_CONTENT_CHARS: usize = 2_000;
const MAX_CLOCK_OFFSET_MS: i64 = 24 * 60 * 60 * 1_000;
const HTTP_DATE_ROUNDING_MS: i64 = 999;
const MAX_CONTINUATION_MISSES: u8 = 8;

#[derive(Debug, Clone)]
pub struct YouTubeDanmakuArgs {
    video_id: String,
}

pub fn args_from_raw(room_id: &str, raw: &Value) -> AppResult<YouTubeDanmakuArgs> {
    let candidate = raw
        .get("video_id")
        .and_then(Value::as_str)
        .unwrap_or(room_id)
        .trim();
    if !is_video_id(candidate) {
        return Err(youtube_error(
            "youtube_danmaku_bad_video",
            "YouTube 直播视频标识无效",
        ));
    }
    Ok(YouTubeDanmakuArgs {
        video_id: candidate.to_owned(),
    })
}

fn youtube_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(code, message).with_site("youtube")
}

fn is_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_MESSAGE_ID_BYTES
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn valid_continuation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CONTINUATION_BYTES
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn text_field(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return nonempty(text);
    }
    if let Some(text) = value.get("simpleText").and_then(Value::as_str) {
        return nonempty(text);
    }
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return nonempty(text);
    }
    let mut output = String::new();
    for run in value
        .get("runs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let part = run
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| {
                run.pointer("/emoji/accessibility/accessibilityData/label")
                    .and_then(Value::as_str)
            })
            .or_else(|| run.pointer("/emoji/shortcuts/0").and_then(Value::as_str));
        if let Some(part) = part {
            output.push_str(part);
        }
    }
    nonempty(&output)
}

fn nonempty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn bounded(value: Option<String>, max_chars: usize) -> Option<String> {
    value.map(|value| value.chars().take(max_chars).collect())
}

fn paid_text(renderer: &Value, content: String) -> String {
    text_field(renderer.get("purchaseAmountText"))
        .map(|amount| format!("{amount} {content}"))
        .unwrap_or(content)
}

fn micros_to_millis(value: &str) -> Option<i64> {
    value
        .parse::<u64>()
        .ok()
        .map(|value| value / 1_000)
        .and_then(|value| i64::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn timestamp_ms(renderer: &Value) -> Option<i64> {
    renderer
        .get("timestampUsec")
        .and_then(Value::as_str)
        .and_then(micros_to_millis)
}

fn safe_color(value: Option<&Value>) -> Option<String> {
    let value = value.and_then(Value::as_i64)?;
    let rgb = u32::try_from(value & 0x00ff_ffff).ok()?;
    Some(format!("#{rgb:06X}"))
}

fn message_event(
    renderer_name: &str,
    renderer: &Value,
    kind: DanmakuKind,
    content: String,
    super_chat: Option<SuperChatInfo>,
) -> Option<DanmakuEvent> {
    let id = renderer.get("id").and_then(Value::as_str)?;
    if !valid_opaque_id(id) {
        return None;
    }
    let user = bounded(text_field(renderer.get("authorName")), MAX_USER_CHARS)
        .unwrap_or_else(|| "YouTube 用户".to_owned());
    let content = bounded(Some(content), MAX_CONTENT_CHARS)?;
    let timestamp = timestamp_ms(renderer)?;
    let (background_color, background_bottom_color) = match renderer_name {
        "liveChatPaidMessageRenderer" | "liveChatPaidStickerRenderer" => (
            safe_color(renderer.get("bodyBackgroundColor")),
            safe_color(renderer.get("headerBackgroundColor")),
        ),
        _ => (None, None),
    };
    Some(DanmakuEvent {
        kind,
        user,
        is_self: false,
        user_id: renderer
            .get("authorExternalChannelId")
            .and_then(Value::as_str)
            .and_then(|value| valid_opaque_id(value).then(|| value.to_owned())),
        content,
        color: None,
        spans: None,
        super_chat: super_chat.map(|mut info| {
            info.background_color = background_color;
            info.background_bottom_color = background_bottom_color;
            info
        }),
        ts: timestamp,
    })
}

fn renderer_event(renderer_name: &str, renderer: &Value) -> Option<DanmakuEvent> {
    let text = || {
        text_field(renderer.get("message"))
            .or_else(|| text_field(renderer.get("header")))
            .or_else(|| text_field(renderer.get("text")))
    };
    match renderer_name {
        "liveChatTextMessageRenderer" => {
            message_event(renderer_name, renderer, DanmakuKind::Chat, text()?, None)
        }
        "liveChatPaidMessageRenderer" => {
            let content = paid_text(renderer, text()?);
            message_event(
                renderer_name,
                renderer,
                DanmakuKind::SuperChat,
                content,
                Some(SuperChatInfo {
                    ..SuperChatInfo::default()
                }),
            )
        }
        "liveChatPaidStickerRenderer" => {
            let content = text_field(
                renderer
                    .get("sticker")
                    .and_then(|value| value.pointer("/accessibility/accessibilityData/label")),
            )
            .or_else(|| text())
            .unwrap_or_else(|| "YouTube Super Sticker".to_owned());
            let content = paid_text(renderer, content);
            message_event(
                renderer_name,
                renderer,
                DanmakuKind::SuperChat,
                content,
                Some(SuperChatInfo {
                    ..SuperChatInfo::default()
                }),
            )
        }
        "liveChatMembershipItemRenderer" => {
            message_event(renderer_name, renderer, DanmakuKind::Social, text()?, None)
        }
        "liveChatViewerEngagementMessageRenderer" | "liveChatModeChangeMessageRenderer" => {
            message_event(renderer_name, renderer, DanmakuKind::System, text()?, None)
        }
        "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer" | "giftMessageViewModel" => {
            message_event(renderer_name, renderer, DanmakuKind::Gift, text()?, None)
        }
        _ => None,
    }
}

fn collect_actions(actions: &[Value], output: &mut Vec<(String, DanmakuEvent)>) {
    for action in actions {
        if let Some(renderer) = action
            .pointer("/addChatItemAction/item")
            .and_then(Value::as_object)
            && let Some((name, renderer)) = renderer.iter().next()
            && let Some(id) = renderer
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_opaque_id(id))
            && let Some(event) = renderer_event(name, renderer)
        {
            output.push((id.to_owned(), event));
        }
        if let Some(replay) = action
            .get("replayChatItemAction")
            .and_then(|value| value.get("actions"))
            .and_then(Value::as_array)
        {
            collect_actions(replay, output);
        }
    }
}

fn continuation_data(value: &Value) -> Option<(&str, Duration)> {
    for item in value.as_array()?.iter() {
        for key in [
            "invalidationContinuationData",
            "timedContinuationData",
            "reloadContinuationData",
            "continuationData",
            "nextContinuationData",
        ] {
            let Some(data) = item.get(key) else {
                continue;
            };
            let Some(continuation) = data.get("continuation").and_then(Value::as_str) else {
                continue;
            };
            if !valid_continuation(continuation) {
                continue;
            }
            let timeout = data
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .map(Duration::from_millis)
                .unwrap_or(DEFAULT_POLL_INTERVAL)
                .clamp(Duration::from_secs(1), Duration::from_secs(30));
            return Some((continuation, timeout));
        }
    }
    None
}

fn page_continuation_created_ms(page: &Value) -> Option<i64> {
    page.pointer("/continuationContents/liveChatContinuation/continuations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.pointer("/invalidationContinuationData/invalidationId/protoCreationTimestampMs")
                .and_then(Value::as_i64)
        })
        .max()
}

fn http_date_upper_bound_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(value)
        .ok()
        // HTTP Date 只有秒精度。取该秒的末端作为上界，宁可漏掉边界前不足
        // 一秒的旧消息，也不让聊天历史在重连时穿过 watermark。
        .map(|value| {
            value
                .timestamp_millis()
                .saturating_add(HTTP_DATE_ROUNDING_MS)
        })
}

fn string_member(page: &str, key: &str) -> Option<String> {
    let marker = format!("\"{key}\":");
    let start = page.find(&marker)? + marker.len();
    let mut stream = serde_json::Deserializer::from_str(&page[start..]).into_iter::<String>();
    stream.next()?.ok()
}

fn find_key<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => {
            if let Some(value) = object.get(key) {
                return Some(value);
            }
            object.values().find_map(|value| find_key(value, key))
        }
        Value::Array(items) => items.iter().find_map(|value| find_key(value, key)),
        _ => None,
    }
}

fn initial_chat(page: &str, video_id: &str) -> Result<(String, String), AppError> {
    let marker = "ytInitialData";
    let payload_start = page
        .match_indices(marker)
        .find_map(|(start, _)| {
            let tail = &page[start + marker.len()..];
            let whitespace = tail.len() - tail.trim_start().len();
            tail[whitespace..]
                .strip_prefix('=')
                .map(|_| start + marker.len() + whitespace + 1)
        })
        .ok_or_else(|| youtube_error("youtube_danmaku_page", "YouTube 直播页面未返回聊天数据"))?;
    let mut stream =
        serde_json::Deserializer::from_str(&page[payload_start..]).into_iter::<Value>();
    let data = stream
        .next()
        .transpose()
        .map_err(|_| youtube_error("youtube_danmaku_page", "YouTube 直播页面格式无效"))?;
    let data = data
        .ok_or_else(|| youtube_error("youtube_danmaku_page", "YouTube 直播页面未返回聊天数据"))?;
    let renderer = find_key(&data, "liveChatRenderer").ok_or_else(|| {
        youtube_error(
            "youtube_danmaku_unavailable",
            "这场 YouTube 直播没有可读取的公开聊天",
        )
    })?;
    let endpoint = renderer
        .pointer("/header/liveChatHeaderRenderer/overflowMenu/menuRenderer/items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                item.pointer("/menuServiceItemRenderer/serviceEndpoint/popoutLiveChatEndpoint/url")
                    .and_then(Value::as_str)
            })
        });
    if endpoint.is_some_and(|url| !url.contains(video_id)) {
        return Err(youtube_error(
            "youtube_danmaku_mismatch",
            "YouTube 返回的聊天与当前直播不一致",
        ));
    }
    let (continuation, _) =
        continuation_data(renderer.get("continuations").ok_or_else(|| {
            youtube_error("youtube_danmaku_unavailable", "YouTube 直播聊天已结束")
        })?)
        .ok_or_else(|| youtube_error("youtube_danmaku_unavailable", "YouTube 直播聊天已结束"))?;
    let client_version = string_member(page, "INNERTUBE_CLIENT_VERSION")
        .or_else(|| {
            find_key(&data, "clientVersion")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|value| {
            value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
        })
        .unwrap_or_else(|| DEFAULT_CLIENT_VERSION.to_owned());
    Ok((continuation.to_owned(), client_version))
}

fn failure_for_status(status: u16) -> SessionFailureKind {
    match status {
        401 | 404 | 410 => SessionFailureKind::Fatal,
        403 | 408 | 429 | 500..=599 => SessionFailureKind::Throttled,
        _ => SessionFailureKind::Transient,
    }
}

async fn post_live_chat(
    client: &reqwest::Client,
    context: &Value,
    continuation: &str,
) -> Result<(Value, Option<i64>), SessionFailureKind> {
    let response = client
        .post(LIVE_CHAT_API)
        .header("User-Agent", USER_AGENT)
        .header("Origin", "https://www.youtube.com")
        .header("Referer", "https://www.youtube.com/")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.7")
        .json(&serde_json::json!({
            "context": context,
            "continuation": continuation,
        }))
        .send()
        .await
        .map_err(|_| SessionFailureKind::Transient)?;
    if !response.status().is_success() {
        return Err(failure_for_status(response.status().as_u16()));
    }
    let server_date_ms = response
        .headers()
        .get("date")
        .and_then(|value| value.to_str().ok())
        .and_then(http_date_upper_bound_ms);
    let page = response
        .json::<Value>()
        .await
        .map_err(|_| SessionFailureKind::Transient)?;
    Ok((page, server_date_ms))
}

#[derive(Debug, Clone, Copy)]
enum SessionFailureKind {
    Fatal,
    Transient,
    Throttled,
}

impl SessionFailureKind {
    fn public_message(self) -> &'static str {
        match self {
            Self::Fatal => "YouTube 直播聊天不可用或已结束",
            Self::Transient => "暂时无法获取 YouTube 直播聊天",
            Self::Throttled => "YouTube 直播聊天暂时限制了请求频率",
        }
    }

    fn reason(self) -> DisconnectReason {
        match self {
            Self::Fatal => DisconnectReason::fatal(self.public_message()),
            Self::Transient => DisconnectReason::transient(self.public_message()),
            Self::Throttled => DisconnectReason::Throttled {
                message: self.public_message().to_owned(),
                floor: Duration::from_secs(15),
                max: Duration::from_secs(60),
            },
        }
    }
}

struct SessionFailure {
    kind: SessionFailureKind,
    messages: u64,
    connected_for: Duration,
}

impl SessionFailure {
    fn before_connected(kind: SessionFailureKind) -> Self {
        Self {
            kind,
            messages: 0,
            connected_for: Duration::ZERO,
        }
    }

    fn reason(self) -> DisconnectReason {
        match self.kind {
            SessionFailureKind::Fatal => self.kind.reason(),
            _ if self.messages > 0
                || self.connected_for >= crate::danmu_rs::reconnect::DEFAULT_HEALTHY_AFTER =>
            {
                DisconnectReason::Dropped {
                    messages: self.messages,
                    connected_for: self.connected_for,
                    detail: Some(self.kind.public_message().to_owned()),
                }
            }
            _ => self.kind.reason(),
        }
    }
}

struct SeenMessages {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl SeenMessages {
    fn new() -> Self {
        Self {
            seen: HashSet::new(),
            order: VecDeque::new(),
        }
    }

    fn accept(&mut self, id: &str) -> bool {
        if !self.seen.insert(id.to_owned()) {
            return false;
        }
        self.order.push_back(id.to_owned());
        if self.order.len() > MAX_SEEN_MESSAGES
            && let Some(oldest) = self.order.pop_front()
        {
            self.seen.remove(&oldest);
        }
        true
    }
}

fn derive_watermark(
    session_started_at: i64,
    page_received_at: i64,
    response_server_time: Option<i64>,
    page: &Value,
    messages: &[(String, DanmakuEvent)],
) -> Option<i64> {
    if let Some(server_time) = page_continuation_created_ms(page).or(response_server_time) {
        let offset = server_time.saturating_sub(page_received_at);
        if offset.unsigned_abs() <= MAX_CLOCK_OFFSET_MS as u64 {
            return Some(session_started_at.saturating_add(offset));
        }
    }

    // 没有可信服务器时钟时，首批消息只能作为历史边界：丢弃这一页，
    // 从最大发布时间之后开始接收。绝不能把它们当成本机当前时间的新消息。
    messages
        .iter()
        .map(|(_, event)| event.ts)
        .max()
        .map(|latest| latest.saturating_add(1))
}

fn page_events(
    page: &Value,
    seen: &mut SeenMessages,
    events: &DanmakuEventSender,
    watermark: &mut Option<i64>,
    session_started_at: i64,
    page_received_at: i64,
    response_server_time: Option<i64>,
) -> u64 {
    let actions = page
        .pointer("/continuationContents/liveChatContinuation/actions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut parsed = Vec::new();
    collect_actions(actions, &mut parsed);
    if watermark.is_none() {
        *watermark = derive_watermark(
            session_started_at,
            page_received_at,
            response_server_time,
            page,
            &parsed,
        );
    }
    let Some(watermark) = *watermark else {
        return 0;
    };
    let mut emitted = 0;
    for (id, event) in parsed {
        if event.ts >= watermark && seen.accept(&id) {
            emit_event(events, event);
            emitted += 1;
        }
    }
    emitted
}

fn next_continuation(page: &Value) -> Option<(&str, Duration)> {
    page.pointer("/continuationContents/liveChatContinuation/continuations")
        .and_then(continuation_data)
        .or_else(|| {
            page.get("continuation")
                .and_then(Value::as_str)
                .filter(|value| valid_continuation(value))
                .map(|value| (value, DEFAULT_POLL_INTERVAL))
        })
}

async fn run_session(
    events: &DanmakuEventSender,
    args: &YouTubeDanmakuArgs,
    client: &reqwest::Client,
    seen: &mut SeenMessages,
    watermark: &mut Option<i64>,
    session_started_at: i64,
) -> Result<Infallible, SessionFailure> {
    let watch_url = format!("https://www.youtube.com/watch?v={}&hl=zh-CN", args.video_id);
    let response = client
        .get(&watch_url)
        .header("User-Agent", USER_AGENT)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.7")
        .send()
        .await
        .map_err(|_| SessionFailure::before_connected(SessionFailureKind::Transient))?;
    if !response.status().is_success() {
        return Err(SessionFailure::before_connected(failure_for_status(
            response.status().as_u16(),
        )));
    }
    let page = response
        .text()
        .await
        .map_err(|_| SessionFailure::before_connected(SessionFailureKind::Transient))?;
    let (continuation, client_version) = initial_chat(&page, &args.video_id).map_err(|error| {
        let kind = match error.code.as_str() {
            "youtube_danmaku_unavailable" | "youtube_danmaku_mismatch" => SessionFailureKind::Fatal,
            _ => SessionFailureKind::Transient,
        };
        SessionFailure::before_connected(kind)
    })?;
    let context = serde_json::json!({
        "client": {
            "clientName": "WEB",
            "clientVersion": client_version,
            "hl": "zh-CN",
            "gl": "US",
        }
    });
    let connected_at = Instant::now();
    emit_system(events, "YouTube 直播聊天已连接");
    let mut cursor = continuation;
    let mut message_count = 0_u64;
    let mut poll_interval = DEFAULT_POLL_INTERVAL;
    let mut continuation_misses = 0_u8;
    loop {
        let (page, response_server_time) = post_live_chat(client, &context, &cursor)
            .await
            .map_err(|kind| SessionFailure {
                kind,
                messages: message_count,
                connected_for: connected_at.elapsed(),
            })?;
        message_count += page_events(
            &page,
            seen,
            events,
            watermark,
            session_started_at,
            chrono::Utc::now().timestamp_millis(),
            response_server_time,
        );
        let Some((next, interval)) = next_continuation(&page) else {
            continuation_misses = continuation_misses.saturating_add(1);
            if continuation_misses >= MAX_CONTINUATION_MISSES {
                return Err(SessionFailure {
                    kind: SessionFailureKind::Transient,
                    messages: message_count,
                    connected_for: connected_at.elapsed(),
                });
            }
            time::sleep(poll_interval).await;
            continue;
        };
        // 同游标在空闲聊天中可能持续一段时间；仍按服务端 timeout 轮询，
        // 不把它误计为游标缺失，否则下一次短暂缺字段就会提前重建会话。
        continuation_misses = 0;
        cursor = next.to_owned();
        poll_interval = interval;
        time::sleep(poll_interval).await;
    }
}

pub async fn run_loop(
    events: DanmakuEventSender,
    args: YouTubeDanmakuArgs,
    route: crate::proxy::ProxyRoute,
) -> AppResult<()> {
    let client = crate::http_client::client_for_route(&route)?;
    let mut seen = SeenMessages::new();
    let session_started_at = chrono::Utc::now().timestamp_millis();
    let mut watermark = None;
    let mut policy = ReconnectPolicy::with_defaults("youtube");
    emit_system(&events, "正在连接 YouTube 直播聊天…");
    loop {
        let reason = match run_session(
            &events,
            &args,
            &client,
            &mut seen,
            &mut watermark,
            session_started_at,
        )
        .await
        {
            Err(failure) => failure.reason(),
            Ok(never) => match never {},
        };
        match policy.on_disconnect(reason) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_and_super_chat_actions() {
        let actions = vec![
            serde_json::json!({
                "addChatItemAction": { "item": {
                    "liveChatTextMessageRenderer": {
                        "id": "message-1",
                        "timestampUsec": "1700000000123456",
                        "authorName": { "simpleText": "@viewer" },
                        "authorExternalChannelId": "UC123",
                        "message": { "runs": [{ "text": "hello" }, { "text": " live" }] }
                    }
                }}
            }),
            serde_json::json!({
                "addChatItemAction": { "item": {
                    "liveChatPaidMessageRenderer": {
                        "id": "message-2",
                        "timestampUsec": "1700000001123456",
                        "authorName": { "simpleText": "@supporter" },
                        "message": { "runs": [{ "text": "super" }] },
                        "bodyBackgroundColor": 4283215696_i64
                    }
                }}
            }),
        ];
        let mut parsed = Vec::new();
        collect_actions(&actions, &mut parsed);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].0, "message-1");
        assert_eq!(parsed[0].1.content, "hello live");
        assert!(matches!(parsed[1].1.kind, DanmakuKind::SuperChat));
        assert!(parsed[1].1.super_chat.is_some());
    }

    #[test]
    fn renders_emoji_accessibility_text() {
        let action = serde_json::json!({
            "addChatItemAction": { "item": {
                "liveChatTextMessageRenderer": {
                    "id": "message-emoji",
                    "timestampUsec": "1700000000123456",
                    "authorName": { "simpleText": "@viewer" },
                    "message": { "runs": [
                        { "text": "好 " },
                        { "emoji": { "accessibility": {
                            "accessibilityData": { "label": "笑脸" }
                        } } }
                    ] }
                }
            }}
        });
        let mut parsed = Vec::new();
        collect_actions(&[action], &mut parsed);
        assert_eq!(parsed[0].1.content, "好 笑脸");
    }

    #[test]
    fn ignores_referenced_marker_and_requires_real_initial_assignment() {
        let no_assignment = r#"const name = "ytInitialData";"#;
        assert!(initial_chat(no_assignment, "4t4AQ15yj1M").is_err());

        let no_chat = r#"var ytInitialData = {"contents":{}};"#;
        assert!(initial_chat(no_chat, "4t4AQ15yj1M").is_err());
    }

    #[test]
    fn rejects_chat_for_another_video() {
        let page = r#"var ytInitialData = {"contents":{"liveChatRenderer":{
            "continuations":[{"reloadContinuationData":{"continuation":"token"}}],
            "header":{"liveChatHeaderRenderer":{"overflowMenu":{"menuRenderer":{"items":[
                {"menuServiceItemRenderer":{"serviceEndpoint":{"popoutLiveChatEndpoint":{
                    "url":"https://www.youtube.com/live_chat?v=AAAAAAAAAAA"
                }}}}
            ]}}}}
        }}};"#;
        assert!(initial_chat(page, "4t4AQ15yj1M").is_err());
    }

    #[test]
    fn parses_the_real_initial_data_assignment() {
        let page = r#"
            const probe = window.ytInitialData;
            var ytInitialData = {"contents":{"liveChatRenderer":{
                "continuations":[{"reloadContinuationData":{"continuation":"token"}}],
                "header":{"liveChatHeaderRenderer":{"overflowMenu":{"menuRenderer":{"items":[
                    {"menuServiceItemRenderer":{"serviceEndpoint":{"popoutLiveChatEndpoint":{
                        "url":"https://www.youtube.com/live_chat?v=4t4AQ15yj1M"
                    }}}}
                ]}}}}
            }}};
            var ytcfg = {"INNERTUBE_CLIENT_VERSION":"2.20261123.08.00"};
        "#;
        let (continuation, version) = initial_chat(page, "4t4AQ15yj1M").unwrap();
        assert_eq!(continuation, "token");
        assert_eq!(version, "2.20261123.08.00");
    }

    #[test]
    fn deduplicates_only_by_renderer_id() {
        let mut seen = SeenMessages::new();
        assert!(seen.accept("renderer-message-id"));
        assert!(!seen.accept("renderer-message-id"));
    }

    #[test]
    fn extracts_continuation_timeout() {
        let value = serde_json::json!([{
            "invalidationContinuationData": {
                "continuation": "next-token",
                "timeoutMs": 5000
            }
        }]);
        let (continuation, interval) = continuation_data(&value).unwrap();
        assert_eq!(continuation, "next-token");
        assert_eq!(interval, Duration::from_secs(5));
    }

    fn event_at(ts: i64) -> DanmakuEvent {
        DanmakuEvent {
            kind: DanmakuKind::Chat,
            user: "viewer".into(),
            is_self: false,
            user_id: None,
            content: "message".into(),
            color: None,
            spans: None,
            super_chat: None,
            ts,
        }
    }

    fn text_action(id: &str, timestamp_usec: Option<&str>) -> Value {
        serde_json::json!({
            "addChatItemAction": { "item": {
                "liveChatTextMessageRenderer": {
                    "id": id,
                    "timestampUsec": timestamp_usec,
                    "authorName": { "simpleText": "@viewer" },
                    "message": { "runs": [{ "text": "message" }] }
                }
            }}
        })
    }

    fn text_action_ms(id: &str, timestamp_ms: i64) -> Value {
        text_action(id, Some(&format!("{timestamp_ms}000")))
    }

    fn chat_page(actions: Vec<Value>, continuation: &str, generated_at_ms: i64) -> Value {
        serde_json::json!({
            "continuationContents": {"liveChatContinuation": {
                "actions": actions,
                "continuations": [{
                    "invalidationContinuationData": {
                        "continuation": continuation,
                        "invalidationId": {
                            "protoCreationTimestampMs": generated_at_ms
                        }
                    }
                }]
            }}
        })
    }

    fn event_channel() -> (
        DanmakuEventSender,
        tokio::sync::mpsc::Receiver<DanmakuEvent>,
    ) {
        let (sender, receiver) = tokio::sync::mpsc::channel(16);
        (
            DanmakuEventSender::new(sender, Default::default()),
            receiver,
        )
    }

    #[test]
    fn skips_first_page_history_but_keeps_same_page_new_messages() {
        let page = serde_json::json!({
            "continuationContents": {"liveChatContinuation": {"continuations": [{
                "invalidationContinuationData": {
                    "continuation": "next",
                    "invalidationId": {
                        "protoCreationTimestampMs": 1_700_000_100_000_i64
                    }
                }
            }]}}
        });
        let history = ("history".to_owned(), event_at(1_699_999_999_999));
        let current = ("current".to_owned(), event_at(1_700_000_100_000));
        let watermark = derive_watermark(
            1_699_999_000_000,
            1_699_999_000_000,
            None,
            &page,
            &[history.clone(), current.clone()],
        );
        assert_eq!(watermark, Some(1_700_000_100_000));

        let value = watermark.unwrap();
        assert!(history.1.ts < value);
        assert!(current.1.ts >= value);
    }

    #[test]
    fn drops_events_without_a_real_timestamp() {
        let mut parsed = Vec::new();
        collect_actions(&[text_action("missing-time", None)], &mut parsed);
        assert!(parsed.is_empty());
    }

    #[test]
    fn uses_message_watermark_when_server_clock_is_missing() {
        let messages = vec![
            ("old".to_owned(), event_at(1_000)),
            ("latest".to_owned(), event_at(2_000)),
        ];
        assert_eq!(
            derive_watermark(500, 1_500, None, &serde_json::json!({}), &messages),
            Some(2_001)
        );
    }

    #[test]
    fn ignores_last_publish_time_as_a_server_clock() {
        let page = serde_json::json!({
            "liveChatStreamingResponseExtension": {
                "lastPublishAtUsec": "1000000"
            }
        });
        let messages = vec![("latest".to_owned(), event_at(2_000))];
        assert_eq!(
            derive_watermark(500, 1_500, None, &page, &messages),
            Some(2_001)
        );
    }

    #[test]
    fn falls_back_to_http_date_and_rejects_implausible_offsets() {
        assert_eq!(
            http_date_upper_bound_ms("Wed, 25 Nov 2026 05:00:00 GMT").unwrap() % 1_000,
            999
        );
        assert_eq!(
            derive_watermark(500, 1_500, Some(2_500), &serde_json::json!({}), &[]),
            Some(1_500)
        );
        assert_eq!(
            derive_watermark(
                500,
                1_500,
                Some(1_500 + MAX_CLOCK_OFFSET_MS + 1),
                &serde_json::json!({}),
                &[("latest".to_owned(), event_at(2_000))]
            ),
            Some(2_001)
        );
    }

    #[test]
    fn page_events_emits_current_message_without_first_page_history() {
        let page = chat_page(
            vec![
                text_action_ms("history", 1_999),
                text_action_ms("current", 2_000),
            ],
            "next",
            3_000,
        );
        let mut watermark = None;
        let mut seen = SeenMessages::new();
        let (sender, mut receiver) = event_channel();
        assert_eq!(
            page_events(
                &page,
                &mut seen,
                &sender,
                &mut watermark,
                1_000,
                2_000,
                None,
            ),
            1
        );
        assert_eq!(receiver.try_recv().unwrap().content, "message");
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn page_events_keeps_watermark_over_empty_page_and_emits_later_message() {
        let mut watermark = Some(2_000);
        let mut seen = SeenMessages::new();
        let (sender, mut receiver) = event_channel();
        let empty = chat_page(Vec::new(), "next", 2_100);
        assert_eq!(
            page_events(
                &empty,
                &mut seen,
                &sender,
                &mut watermark,
                1_000,
                2_000,
                None,
            ),
            0
        );
        assert_eq!(watermark, Some(2_000));

        let later = chat_page(vec![text_action_ms("later", 2_001)], "after", 2_200);
        assert_eq!(
            page_events(
                &later,
                &mut seen,
                &sender,
                &mut watermark,
                1_000,
                2_000,
                None,
            ),
            1
        );
        assert_eq!(receiver.try_recv().unwrap().ts, 2_001);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn page_events_does_not_replay_seen_ids_after_reconnect() {
        let page = chat_page(vec![text_action_ms("renderer-id", 2_001)], "next", 2_100);
        let mut watermark = Some(2_000);
        let mut seen = SeenMessages::new();
        let (sender, mut receiver) = event_channel();
        for expected in [1, 0] {
            assert_eq!(
                page_events(
                    &page,
                    &mut seen,
                    &sender,
                    &mut watermark,
                    1_000,
                    2_000,
                    None,
                ),
                expected
            );
        }
        assert_eq!(receiver.try_recv().unwrap().ts, 2_001);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn page_events_keeps_distinct_ids_at_the_same_timestamp() {
        let page = chat_page(
            vec![
                text_action_ms("first-id", 2_001),
                text_action_ms("second-id", 2_001),
            ],
            "next",
            2_100,
        );
        let mut watermark = Some(2_000);
        let mut seen = SeenMessages::new();
        let (sender, mut receiver) = event_channel();
        assert_eq!(
            page_events(
                &page,
                &mut seen,
                &sender,
                &mut watermark,
                1_000,
                2_000,
                None,
            ),
            2
        );
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_ok());
    }

    #[test]
    fn continues_across_empty_pages_and_long_continuations() {
        let long_token = "x".repeat(4_096);
        let first = serde_json::json!({
            "continuationContents": {"liveChatContinuation": {
                "actions": [],
                "continuations": [{"continuationData": {
                    "continuation": long_token,
                    "timeoutMs": 2000
                }}]
            }}
        });
        let (next, interval) = next_continuation(&first).unwrap();
        assert_eq!(next.len(), 4_096);
        assert_eq!(interval, Duration::from_secs(2));

        let second = serde_json::json!({
            "continuationContents": {"liveChatContinuation": {
                "actions": [{
                    "addChatItemAction": { "item": {
                        "liveChatTextMessageRenderer": {
                            "id": "later-message",
                            "timestampUsec": "1700000000000000",
                            "authorName": { "simpleText": "@viewer" },
                            "message": { "runs": [{ "text": "later" }] }
                        }
                    }}
                }],
                "continuations": [{"nextContinuationData": {
                    "continuation": "third"
                }}]
            }}
        });
        assert_eq!(next_continuation(&second).unwrap().0, "third");
    }

    #[test]
    fn reconnecting_with_the_same_watermark_does_not_replay_seen_messages() {
        let watermark = 1_700_000_000_000;
        let event = event_at(watermark);
        let mut seen = SeenMessages::new();
        assert!(event.ts >= watermark && seen.accept("renderer-id"));
        assert!(!(event.ts >= watermark && seen.accept("renderer-id")));
    }

    #[test]
    fn transient_disconnect_still_uses_retry_backoff() {
        let failure = SessionFailure::before_connected(SessionFailureKind::Transient);
        let mut policy = ReconnectPolicy::with_defaults("youtube-test");
        match policy.on_disconnect(failure.reason()) {
            Decision::Retry { delay, .. } => {
                assert!(delay >= Duration::from_secs(1));
                assert!(delay <= Duration::from_millis(1_800));
            }
            Decision::Stop { notice, .. } => panic!("expected retry, stopped: {notice}"),
        }
    }

    #[test]
    fn fatal_disconnect_does_not_retry() {
        let failure = SessionFailure::before_connected(SessionFailureKind::Fatal);
        let mut policy = ReconnectPolicy::with_defaults("youtube-test");
        assert!(matches!(
            policy.on_disconnect(failure.reason()),
            Decision::Stop { .. }
        ));
    }
}
