//! 站点弹幕发送共用的 HTTP CONNECT 代理工具。
//!
//! 各站点保留自己的错误码、错误消息与响应校验逻辑；这里只收拢
//! 两边逐字一致的部分：代理凭据解码、Basic 认证头和 CONNECT 请求字节。

use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::Url;

use crate::error::{AppError, AppResult};

/// 由各站点提供的错误构造器，保证共享逻辑产生的错误码、
/// 消息与可重试标记和站点原先的手写实现逐字一致。
pub(crate) struct ProxyCredentialErrors {
    /// user-info 中出现非法的百分号编码序列。
    pub invalid_encoding: fn() -> AppError,
    /// 只提供了用户名或只提供了密码。
    pub incomplete_credentials: fn() -> AppError,
}

/// 解码 URL 的 user-info 部分且不把 `+` 当作空格。代理凭据属于 URL 组成部分
/// 而非表单数据，下面的 Basic 认证会安全地对结果字节重新编码。
///
/// 刻意不用 `percent_encoding`：它对非法序列按字面字节放行，
/// 而这里必须在用户拼错凭据时明确报错。
pub(crate) fn percent_decode_proxy_credential(
    value: &str,
    errors: &ProxyCredentialErrors,
) -> AppResult<Vec<u8>> {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let Some(high) = bytes.get(index + 1).and_then(|byte| hex(*byte)) else {
            return Err((errors.invalid_encoding)());
        };
        let Some(low) = bytes.get(index + 2).and_then(|byte| hex(*byte)) else {
            return Err((errors.invalid_encoding)());
        };
        decoded.push((high << 4) | low);
        index += 3;
    }
    Ok(decoded)
}

pub(crate) fn proxy_authorization(
    url: &Url,
    errors: &ProxyCredentialErrors,
) -> AppResult<Option<String>> {
    let username = url.username();
    let password = url.password();
    if username.is_empty() && password.is_none() {
        return Ok(None);
    }
    let password = password.ok_or_else(errors.incomplete_credentials)?;

    let mut credentials = percent_decode_proxy_credential(username, errors)?;
    credentials.push(b':');
    credentials.extend(percent_decode_proxy_credential(password, errors)?);
    Ok(Some(STANDARD.encode(credentials)))
}

/// 构造标准的 HTTP CONNECT 请求字节。
pub(crate) fn connect_request(target: &str, authorization: Option<&str>) -> Vec<u8> {
    let mut request =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\n");
    if let Some(credential) = authorization {
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(credential);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request.into_bytes()
}
