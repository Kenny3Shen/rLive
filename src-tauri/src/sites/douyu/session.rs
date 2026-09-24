//! 斗鱼账号 Cookie 处理、发送域约束与会话有效性探针。

use reqwest::Url;
use serde_json::Value;

use super::{UA, sign};
use crate::http_client;

/// 只需要登录态、返回体最小的斗鱼 Web 接口。斗鱼没有第一方的「账号资料」
/// 读接口，因此用关注列表的第一页作为会话探针。
const SESSION_PROBE_URL: &str =
    "https://www.douyu.com/wgapi/livenc/liveweb/follow/list?sort=0&cid1=0&offset=0&limit=1";
/// 该 Web 网关对未登录和已过期会话统一返回 `error = -1`
/// （`msg` 为「用户未登陆或token已过期」）。其它非零取值是业务或风控失败
/// （例如搜索接口的 `error = 8` 需要完成验证），不能当作会话已失效。
const SESSION_REJECTED_ERROR: i64 = -1;

/// 保存的斗鱼浏览器 Cookie 是否仍被平台接受。
///
/// 平台确认该会话时返回 `Some(true)`；明确拒绝（未登录／token 已过期）时返回
/// `Some(false)`；无法判定（网络失败、风控或无法识别的响应）时返回 `None`。
/// 调用方据此提示重新登录，因此这里对 `false` 保持保守：只有可识别的拒绝
/// 才算失效。
pub async fn cookie_session_status(cookie: &str, proxy: Option<&str>) -> Option<bool> {
    let cookie = normalize_cookie(cookie);
    if cookie.is_empty() {
        return Some(false);
    }
    // 该接口按浏览器设备身份寻址。保留已保存的取值，仅在缺失时补上与搜索
    // 请求一致的稳定兜底 did，避免因缺字段被判成不可识别的失败。
    let cookie = merge_cookie_values(
        &format!(
            "dy_did={}; acf_did={}",
            sign::SIGN_DEVICE_ID,
            sign::SIGN_DEVICE_ID
        ),
        &cookie,
    );
    let client = http_client::client_for_proxy(proxy).ok()?;
    let response = client
        .get(SESSION_PROBE_URL)
        .header("user-agent", UA)
        .header("referer", "https://www.douyu.com/directory/myFollow")
        .header("cookie", cookie)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    parse_session_status(&response.text().await.ok()?)
}

fn parse_session_status(body: &str) -> Option<bool> {
    let response: Value = serde_json::from_str(body).ok()?;
    let error = response
        .get("error")
        .or_else(|| response.get("code"))
        .and_then(json_strict_i64)?;
    match error {
        0 => Some(true),
        SESSION_REJECTED_ERROR => Some(false),
        _ => None,
    }
}

/// 与 [`super::json_i64`] 不同：不把缺失或无法解析的字段折成 `0`。会话判定不能把
/// 无法识别的响应当成一次成功的登录确认。
fn json_strict_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|value| value as i64))
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
}

pub(super) fn normalize_cookie(value: &str) -> String {
    merge_cookie_values(
        "",
        value.trim().strip_prefix("Cookie:").unwrap_or(value).trim(),
    )
}

/// 账号 Cookie 的作用域限定在斗鱼的 HTTPS Web 主机。保持显式声明，
/// 可避免未来的调用点仅因为复用了 JSON 辅助函数，
/// 就把保存的 Cookie 重放到任意 URL。
pub(super) fn is_douyu_cookie_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == "douyu.com" || host.ends_with(".douyu.com"))
}

fn cookie_pairs(value: &str) -> Vec<(String, String)> {
    value
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            let key = key.trim();
            (!key.is_empty()).then(|| (key.to_string(), value.trim().to_string()))
        })
        .collect()
}

pub(super) fn merge_cookie_values(base: &str, updates: &str) -> String {
    let mut merged = cookie_pairs(base);
    for (key, value) in cookie_pairs(updates) {
        if let Some((_, previous)) = merged
            .iter_mut()
            .find(|(previous_key, _)| previous_key.eq_ignore_ascii_case(&key))
        {
            *previous = value;
        } else {
            merged.push((key, value));
        }
    }
    merged
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_saved_cookies_to_douyu_https_hosts() {
        assert!(is_douyu_cookie_url("https://www.douyu.com/japi/weblist"));
        assert!(is_douyu_cookie_url("https://m.douyu.com/api/cate/list"));
        assert!(!is_douyu_cookie_url("http://www.douyu.com/japi/weblist"));
        assert!(!is_douyu_cookie_url("https://douyu.com.example.test/api"));
        assert!(!is_douyu_cookie_url("https://webcast.amemv.com/api"));
    }

    /// 会话判定只接受可识别的拒绝：风控、非 JSON 或缺字段都必须留在「未知」，
    /// 否则设置页会把一个仍然有效的账号当成已失效并自动退出登录。
    #[test]
    fn session_status_only_trusts_recognizable_gateway_replies() {
        assert_eq!(
            parse_session_status(r#"{"error":0,"data":{"list":[]}}"#),
            Some(true)
        );
        assert_eq!(
            parse_session_status(r#"{"code":-1,"error":-1,"msg":"用户未登陆或token已过期"}"#),
            Some(false)
        );
        assert_eq!(
            parse_session_status(r#"{"error":8,"msg":"您的行为可能存在风险, 请完成验证"}"#),
            None
        );
        assert_eq!(parse_session_status(r#"{"data":{"list":[]}}"#), None);
        assert_eq!(parse_session_status("<html>404</html>"), None);
    }
}
