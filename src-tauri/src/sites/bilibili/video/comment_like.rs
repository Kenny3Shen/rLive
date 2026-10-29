//! 评论点赞 / 取消点赞。Cookie/CSRF 只在后端使用，不自动重试。
//!
//! 协议参考 PiliPlus `ReplyHttp.likeReply`：
//! https://github.com/bggRGjQaUbCoE/PiliPlus/blob/e154970443343ff61e849a67c69cb5fe50481870/lib/http/reply.dart
//! `POST /x/v2/reply/action`，表单 `type=1`、`oid=aid`、`rpid`、`action`（1 赞 / 0 取消）、`csrf`。

use reqwest::Client;
use serde_json::Value;

use super::comment_send::{error, normalize_aid};
use crate::account::cookie_header_value;
use crate::danmu_rs::bilibili::{cookie_value, has_send_credentials};
use crate::error::AppResult;

const LIKE_COMMENT_URL: &str = "https://api.bilibili.com/x/v2/reply/action";

/// client 必须由 `build_no_redirect_client` 创建，防止写入携带的凭据被重定向泄漏。
pub async fn like_comment(
    client: &Client,
    cookie: &str,
    aid: &str,
    rpid: i64,
    like: bool,
) -> AppResult<()> {
    like_comment_to_url(client, cookie, aid, rpid, like, LIKE_COMMENT_URL).await
}

async fn like_comment_to_url(
    client: &Client,
    cookie: &str,
    aid: &str,
    rpid: i64,
    like: bool,
    url: &str,
) -> AppResult<()> {
    let aid = normalize_aid(aid)?;
    if rpid <= 0 {
        return Err(error(
            "video_comment_invalid_rpid",
            "评论已失效，请刷新评论区",
        ));
    }
    let cookie = cookie_header_value(cookie)
        .filter(|cookie| has_send_credentials(cookie))
        .ok_or_else(|| {
            error(
                "video_comment_login_required",
                "请先在设置 → 账号登录 B站 Web 账号，或保存含 SESSDATA 和 bili_jct 的 Cookie",
            )
        })?;
    let csrf = cookie_value(cookie, "bili_jct").unwrap_or_default();
    let response = client
        .post(url)
        .header("user-agent", super::DEFAULT_USER_AGENT)
        .header("referer", format!("https://www.bilibili.com/video/av{aid}"))
        .header("origin", super::VIDEO_REFERER)
        .header("cookie", cookie)
        .form(&[
            ("type", "1".to_owned()),
            ("oid", aid),
            ("rpid", rpid.to_string()),
            ("action", if like { "1" } else { "0" }.to_owned()),
            ("csrf", csrf),
        ])
        .send()
        .await
        .map_err(|_| unknown_result())?;
    match response.status().as_u16() {
        200..=299 => {}
        401 => return Err(login_expired()),
        412 | 429 => return Err(limited()),
        500..=599 => return Err(unknown_result()),
        _ => return Err(rejected(None)),
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| unknown_result())?;
    parse_like_result(&value)
}

fn unknown_result() -> crate::error::AppError {
    error(
        "video_comment_like_unknown",
        "点赞状态未知，请刷新评论区确认",
    )
}

fn login_expired() -> crate::error::AppError {
    error(
        "video_comment_login_expired",
        "B站登录已失效，请在设置 → 账号重新登录",
    )
}

fn limited() -> crate::error::AppError {
    error("video_comment_send_limited", "B站暂时限制点赞，请稍后再试")
}

fn rejected(code: Option<i64>) -> crate::error::AppError {
    let message = match code {
        Some(code) => format!("B站未接受点赞（错误码 {code}），评论可能已被删除"),
        None => "B站未接受点赞，请检查账号状态".to_owned(),
    };
    error("video_comment_like_rejected", message)
}

fn parse_like_result(value: &Value) -> AppResult<()> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => Ok(()),
        Some(-101 | -111) => Err(login_expired()),
        Some(-412) => Err(limited()),
        Some(code) => Err(rejected(Some(code))),
        None => Err(unknown_result()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::comment_send::tests::{client, response_server, sent_form};
    use super::*;

    #[tokio::test]
    async fn posts_like_and_unlike_action() {
        for (like, action) in [(true, "1"), (false, "0")] {
            let (url, server) = response_server("200 OK", r#"{"code":0}"#, "");
            like_comment_to_url(
                &client(),
                "SESSDATA=session; bili_jct=csrf",
                "123",
                42,
                like,
                &url,
            )
            .await
            .unwrap();
            let request = server.join().unwrap();
            assert!(request.starts_with("POST /reply/add HTTP/1.1"));
            let form = sent_form(&request);
            assert_eq!(form.len(), 5);
            assert_eq!(form["type"], "1");
            assert_eq!(form["oid"], "123");
            assert_eq!(form["rpid"], "42");
            assert_eq!(form["action"], action);
            assert_eq!(form["csrf"], "csrf");
        }
    }

    #[tokio::test]
    async fn invalid_target_or_missing_cookie_never_reaches_network() {
        for (cookie, aid, rpid, code) in [
            (
                "SESSDATA=s; bili_jct=c",
                "123",
                0,
                "video_comment_invalid_rpid",
            ),
            (
                "SESSDATA=s; bili_jct=c",
                "BV1x",
                1,
                "video_comment_invalid_aid",
            ),
            ("SESSDATA=s", "123", 1, "video_comment_login_required"),
        ] {
            let err = like_comment_to_url(&client(), cookie, aid, rpid, true, "http://127.0.0.1:1")
                .await
                .unwrap_err();
            assert_eq!(err.code, code);
        }
    }

    #[test]
    fn classifies_upstream_codes() {
        assert!(parse_like_result(&serde_json::json!({"code": 0})).is_ok());
        for (value, code) in [
            (
                serde_json::json!({"code": -101}),
                "video_comment_login_expired",
            ),
            (
                serde_json::json!({"code": -412}),
                "video_comment_send_limited",
            ),
            (
                serde_json::json!({"code": 12022}),
                "video_comment_like_rejected",
            ),
            (serde_json::json!({}), "video_comment_like_unknown"),
        ] {
            let err = parse_like_result(&value).unwrap_err();
            assert_eq!(err.code, code);
            assert!(!err.retryable);
        }
    }
}
