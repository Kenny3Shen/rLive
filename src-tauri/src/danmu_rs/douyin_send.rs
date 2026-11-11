//! 抖音直播普通文本弹幕的发送边界。
//!
//! 凭据、文本与上游确认在本地收敛；带 Cookie 的写入只交给站点请求层，
//! 不产生乐观回显，也不对结果不明的请求自动重试。

use crate::account::cookie_header_value;
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};
use crate::sites::cookie::cookie_pairs;

/// 抖音聊天写入响应中由平台确认的消息。
///
/// 三个字段都来自成功响应的 `data`：不是从本地输入草稿拼出的乐观消息。
/// 该结构只在 Rust 内传给共享弹幕事件链，不改变 Tauri command 的返回类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmedChat {
    pub message_id: String,
    pub user: String,
    pub content: String,
}

impl ConfirmedChat {
    /// 把消息 ID 从内容中拆出，让共享去重入口能先按 ID 查重再消费事件。
    pub fn into_parts(self) -> (String, DanmakuEvent) {
        let Self {
            message_id,
            user,
            content,
        } = self;
        (
            message_id,
            DanmakuEvent {
                kind: DanmakuKind::Chat,
                user,
                is_self: true,
                user_id: None,
                content,
                color: None,
                spans: None,
                super_chat: None,
                ts: chrono::Utc::now().timestamp_millis(),
            },
        )
    }
}

/// 抖音 Web 直播间普通文本弹幕的保守上限，按 UTF-16 码元计。
pub const MAX_OUTGOING_CHAT_UTF16_UNITS: usize = 50;

/// 本地状态命令只判断保存的会话是否具备官网登录所需的会话字段。
/// 这是必要条件的检查，是否已过期仍由上游写入与账号探针裁决。
pub fn has_send_credentials(cookie: &str) -> bool {
    let Some(cookie) = cookie_header_value(cookie) else {
        return false;
    };
    cookie_pairs(cookie).iter().any(|(key, value)| {
        matches!(key.as_str(), "sessionid" | "sessionid_ss") && !value.is_empty()
    })
}

/// 在占用发送冷却之前校验用户输入的普通文本。发送函数也会重复这套校验。
pub fn normalize_outgoing_message(value: &str) -> AppResult<String> {
    let message = value.trim();
    if message.is_empty() {
        return Err(
            AppError::new("douyin_send_empty", "请输入要发送的弹幕内容").with_site("douyin")
        );
    }
    if message.encode_utf16().count() > MAX_OUTGOING_CHAT_UTF16_UNITS {
        return Err(AppError::new(
            "douyin_send_too_long",
            format!("单条弹幕最多 {MAX_OUTGOING_CHAT_UTF16_UNITS} 个字符"),
        )
        .with_site("douyin"));
    }
    if message.chars().any(char::is_control) {
        return Err(
            AppError::new("douyin_send_invalid_text", "弹幕不能包含换行或控制字符")
                .with_site("douyin"),
        );
    }
    Ok(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_status_requires_a_nonempty_login_session() {
        assert!(has_send_credentials("sessionid=abc; ttwid=anonymous"));
        assert!(has_send_credentials(
            "Cookie: sessionid_ss=abc; ttwid=anonymous"
        ));
        assert!(!has_send_credentials("ttwid=anonymous; msToken=token"));
        assert!(!has_send_credentials("sessionid=; sessionid_ss="));
        assert!(!has_send_credentials("sessionid=abc\r\nInjected: value"));
    }

    #[test]
    fn outgoing_message_is_single_line_and_bounded() {
        assert_eq!(normalize_outgoing_message("  你好  ").unwrap(), "你好");
        assert!(normalize_outgoing_message("\n").is_err());
        assert!(normalize_outgoing_message("hello\nworld").is_err());
        assert!(normalize_outgoing_message("直播间中文测试？").is_ok());
        assert!(normalize_outgoing_message(&"a".repeat(MAX_OUTGOING_CHAT_UTF16_UNITS)).is_ok());
        assert!(
            normalize_outgoing_message(&"a".repeat(MAX_OUTGOING_CHAT_UTF16_UNITS + 1)).is_err()
        );
        assert!(normalize_outgoing_message(&"😀".repeat(25)).is_ok());
        assert!(normalize_outgoing_message(&"😀".repeat(26)).is_err());
    }
}
