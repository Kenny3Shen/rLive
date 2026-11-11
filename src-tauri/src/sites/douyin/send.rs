//! 抖音网页直播间的单条聊天写入。
//!
//! 当前 Web 客户端使用带 `a_bogus` 签名的 `GET /webcast/room/chat/`。
//! 请求签名、房间身份与会话 Cookie 共用 [`super::api`] 的一次请求链；
//! 这条 GET 是写入操作，绝不参与读取接口的风控重试，
//! 也只有上游明确返回业务成功时才允许调用方记录发送历史。

use reqwest::StatusCode;
use serde_json::Value;

use super::api::{LIVE_ROOT, RawResponse, generate_ms_token};
use crate::danmu_rs::douyin_send::ConfirmedChat;
use crate::error::{AppError, AppResult};
use crate::models::live::LiveRoomDetail;
use crate::sites::douyin::DouyinSite;

const SEND_CHAT_URL: &str = "https://live.douyin.com/webcast/room/chat/";

/// 官网聊天写入所需的公共浏览器参数。顺序与 Web 客户端一致，
/// 且必须与本地 `a_bogus` 计算所用的 `DEFAULT_USER_AGENT` 环境指纹相同。
fn chat_params(room_id: &str, message: &str) -> Vec<(String, String)> {
    [
        ("aid", "6383"),
        ("app_name", "douyin_web"),
        ("live_id", "1"),
        ("device_platform", "web"),
        ("language", "zh-CN"),
        ("enter_from", "web_live"),
        ("cookie_enabled", "true"),
        ("screen_width", "1920"),
        ("screen_height", "1080"),
        ("browser_language", "zh-CN"),
        ("browser_platform", "Win32"),
        ("browser_name", "Chrome"),
        ("browser_version", "125.0.0.0"),
        ("os_name", "Windows"),
        ("os_version", "10"),
        ("room_id", room_id),
        ("content", message),
        ("type", "0"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value.to_owned()))
    .chain(std::iter::once(("msToken".to_owned(), generate_ms_token())))
    .collect()
}

fn unknown() -> AppError {
    AppError::new(
        "douyin_send_unknown",
        "发送状态未知，请到直播间确认是否已送达",
    )
    .with_site("douyin")
    .retryable()
}

/// 上游提示只作为可选的用户反馈：限制长度并去掉控制字符。这里只读取
/// 根节点的字符串字段，不对任意 URL、query 或凭据做语义过滤。
fn displayable_upstream_message(value: &Value) -> Option<String> {
    const MAX_CHARS: usize = 80;
    let text = ["message", "status_msg", "prompts", "error"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))?
        .trim();
    let cleaned: String = text
        .chars()
        .filter(|ch| !ch.is_control() && !ch.is_ascii_control())
        .take(MAX_CHARS)
        .collect();
    (!cleaned.is_empty()).then(|| cleaned)
}

fn rejected(code: i64, value: &Value) -> AppError {
    let message = displayable_upstream_message(value).unwrap_or_else(|| {
        format!("抖音未接受此条弹幕（状态 {code}），请检查账号状态或直播间限制")
    });
    AppError::new("douyin_send_rejected", message).with_site("douyin")
}

/// 仅记录诊断所需的不敏感结构：状态、业务码、响应字段名和平台给定的
/// 错误类型。响应正文可能回显 query 或用户文本，绝不写入日志。
fn trace_response(status: StatusCode, value: Option<&Value>) {
    let status_code = value
        .and_then(|value| value.get("status_code"))
        .and_then(Value::as_i64);
    let data_keys: Vec<&str> = value
        .and_then(|value| value.get("data"))
        .and_then(Value::as_object)
        .map(|data| data.keys().map(String::as_str).collect())
        .unwrap_or_default();
    let error_keys: Vec<&str> = value
        .and_then(Value::as_object)
        .map(|root| {
            root.keys()
                .map(String::as_str)
                .filter(|key| {
                    matches!(
                        *key,
                        "message" | "status_msg" | "prompts" | "error" | "error_code"
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    tracing::info!(
        site = "douyin",
        stage = "send_chat_response",
        http_status = status.as_u16(),
        ?status_code,
        ?data_keys,
        ?error_keys,
        "douyin send response shape"
    );
}

/// 只有平台明确接受消息时才返回成功；非 JSON、空正文、未知业务码均不能
/// 被当成确认。调用方据此决定是否写入本地发送历史。
/// 失败或非 JSON 仍按现有严格规则报错；HTTP 成功、`status_code=0` 但
/// `data` 缺字段时返回 `Ok(None)`：平台提交已经成功，只是没有可显示的
/// 确认消息，不能用输入草稿补造。
fn parse_send_response(status: StatusCode, text: &str) -> AppResult<Option<ConfirmedChat>> {
    let value: Option<Value> = serde_json::from_str(text).ok();
    trace_response(status, value.as_ref());
    if !status.is_success() {
        return Err(value
            .as_ref()
            .and_then(|value| displayable_upstream_message(value))
            .map(|message| AppError::new("douyin_send_rejected", message).with_site("douyin"))
            .unwrap_or_else(|| {
                AppError::new(
                    "douyin_send_rejected",
                    format!("抖音未接受此条弹幕（HTTP {status}），请稍后重试"),
                )
                .with_site("douyin")
                .retryable()
            }));
    }
    let value = value.ok_or_else(unknown)?;
    let code = value
        .get("status_code")
        .and_then(Value::as_i64)
        .ok_or_else(unknown)?;
    match code {
        0 => Ok(confirmed_chat(&value)),
        // 这个码由第一方账号探针明确表示「未登录」，也是本项目已验证的语义。
        20003 => Err(AppError::new(
            "douyin_send_login_expired",
            "抖音登录状态已失效，请更新 Cookie 后重试",
        )
        .with_site("douyin")),
        _ => Err(rejected(code, &value)),
    }
}

/// `msg_id_str` 优先保留字符串以避免大整数精度损失；平台只给数值 id 时
/// 用 serde 的 u64 渲染兜底。ID 统一规范为 WSS 外层 field3 的十进制字符串，
/// 避免前导零让同一条消息的两条路径无法去重。`content`、昵称和消息 ID
/// 缺任一有效值都不合成。
fn confirmed_chat(value: &Value) -> Option<ConfirmedChat> {
    let data = value.get("data")?;
    let message_id = json_id(data.get("msg_id_str")).or_else(|| json_id(data.get("msg_id")))?;
    let content = bounded_response_text(data.get("content")?, 500)?;
    let user = bounded_response_text(data.get("user")?.get("nickname")?, 128)?;
    Some(ConfirmedChat {
        message_id,
        user,
        content,
    })
}

fn json_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => {
            let value = value.trim();
            if value.is_empty()
                || value.len() > 64
                || !value.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            nonzero_id(value.parse::<u64>().ok()?)
        }
        Value::Number(value) => nonzero_id(value.as_u64()?),
        _ => None,
    }
}

fn nonzero_id(value: u64) -> Option<String> {
    (value != 0).then(|| value.to_string())
}

fn bounded_response_text(value: &Value, max_chars: usize) -> Option<String> {
    let text: String = value
        .as_str()?
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max_chars)
        .collect();
    (!text.is_empty()).then_some(text)
}

pub(super) async fn send_chat(
    site: &DouyinSite,
    room_id: &str,
    detail: &LiveRoomDetail,
    message: &str,
) -> AppResult<Option<ConfirmedChat>> {
    let normalized = crate::danmu_rs::douyin_send::normalize_outgoing_message(message)?;
    // 房间页解析已经建立本次临时 Web 会话；这里确保签名、Cookie 与请求链一致。
    site.ensure_web_session().await?;
    let referer = format!("{LIVE_ROOT}{}", detail.room_id.trim());
    let params = chat_params(room_id, &normalized);
    // 仅此一次 GET，网络层失败也保留为「状态未知」，由用户到直播间确认。
    let response = site
        .send_signed_chat_once(SEND_CHAT_URL, &params, &referer)
        .await
        .map_err(|_| unknown())?;
    // 写入响应已经结束本次请求链，不再合并临时 Set-Cookie；
    // 本地会话处理失败绝不能把上游已接受的消息变成一次假失败。
    let RawResponse { status, text, .. } = response;
    parse_send_response(status, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_success_is_accepted() {
        assert_eq!(
            parse_send_response(StatusCode::OK, r#"{"status_code":0,"data":{}}"#).unwrap(),
            None
        );
        for body in [
            "",
            "unexpected",
            r#"{"data":{}}"#,
            r#"{"status_code":"0"}"#,
            r#"{"status_code":1,"data":{}}"#,
        ] {
            assert!(parse_send_response(StatusCode::OK, body).is_err(), "{body}");
        }
        assert!(parse_send_response(StatusCode::FORBIDDEN, r#"{"status_code":0}"#).is_err());
        assert!(
            parse_send_response(
                StatusCode::OK,
                r#"{"status_code":0,"data":{"message_id":"123"}}"#
            )
            .unwrap()
            .is_none()
        );
        let error = parse_send_response(StatusCode::OK, r#"{"status_code":20003}"#).unwrap_err();
        assert_eq!(error.code, "douyin_send_login_expired");
        let error = parse_send_response(StatusCode::OK, r#"{"status_code":10011}"#).unwrap_err();
        assert_eq!(error.code, "douyin_send_rejected");
        assert!(error.message.contains("10011"));
        let error = parse_send_response(
            StatusCode::OK,
            r#"{"status_code":1,"message":"直播间暂时无法发言"}"#,
        )
        .unwrap_err();
        assert_eq!(error.message, "直播间暂时无法发言");
        let error = parse_send_response(StatusCode::OK, r#"{"status_code":1,"message":"\n\t"}"#)
            .unwrap_err();
        assert!(error.message.contains('1'));
    }

    #[test]
    fn successful_response_uses_only_server_confirmed_message_fields() {
        let body = serde_json::json!({
            "status_code": 0,
            "data": {
                "msg_id_str": "7706880368884470826",
                "content": "弹幕氛围好差，玩乐器的大姐姐在癞痢？",
                "user": {"nickname": "Kenny3S"},
                "extra": "ignored"
            }
        });
        let chat = parse_send_response(StatusCode::OK, &body.to_string())
            .unwrap()
            .expect("完整服务器确认消息");
        assert_eq!(chat.message_id, "7706880368884470826");
        assert_eq!(chat.user, "Kenny3S");
        assert_eq!(chat.content, "弹幕氛围好差，玩乐器的大姐姐在癞痢？");

        for body in [
            serde_json::json!({"status_code":0}),
            serde_json::json!({"status_code":0,"data":null}),
            serde_json::json!({"status_code":0,"data":{"content":"服务器内容","msg_id_str":"1"}}),
            serde_json::json!({"status_code":0,"data":{"content":"服务器内容","user":{"nickname":"昵称"}}}),
            serde_json::json!({"status_code":0,"data":{"content":" ","user":{"nickname":"昵称"},"msg_id_str":"1"}}),
            serde_json::json!({"status_code":0,"data":{"content":"服务器内容","user":{"nickname":"昵称"},"msg_id_str":""}}),
        ] {
            assert_eq!(
                parse_send_response(StatusCode::OK, &body.to_string()).unwrap(),
                None,
                "{body}"
            );
        }
        assert_eq!(
            parse_send_response(
                StatusCode::OK,
                r#"{"status_code":0,"data":{"msg_id":7706880368884470826,"content":"服务器内容","user":{"nickname":"昵称"}}}"#
            )
            .unwrap()
            .unwrap()
            .message_id,
            "7706880368884470826"
        );
        let body = serde_json::json!({
            "status_code": 0,
            "data": {
                "msg_id_str": "0007706880368884470826",
                "content": "服务器内容",
                "user": {"nickname": "昵称"}
            }
        });
        assert_eq!(
            parse_send_response(StatusCode::OK, &body.to_string())
                .unwrap()
                .unwrap()
                .message_id,
            "7706880368884470826"
        );
        // 无效 ID 不能用本地草稿补造确认消息；数值 0 也不能让不同消息互相去重。
        for message_id in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("0"),
            serde_json::json!("000"),
            serde_json::json!("abc"),
            serde_json::json!("18446744073709551616"),
            serde_json::json!(true),
        ] {
            let body = serde_json::json!({
                "status_code": 0,
                "data": {
                    "msg_id_str": message_id,
                    "content": "服务器内容",
                    "user": {"nickname": "昵称"}
                }
            });
            assert_eq!(
                parse_send_response(StatusCode::OK, &body.to_string()).unwrap(),
                None,
                "{body}"
            );
        }
    }
}
