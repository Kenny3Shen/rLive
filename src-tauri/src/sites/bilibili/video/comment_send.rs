//! 文本评论与回复写入。Cookie/CSRF 只在后端使用，不自动重试或伪造评论回显。
//!
//! 协议参考 PiliPlus `VideoHttp.replyAdd`：
//! https://github.com/bggRGjQaUbCoE/PiliPlus/blob/e154970443343ff61e849a67c69cb5fe50481870/lib/http/video.dart
//! `type=1`、`oid=aid`，一级评论不传 `root`/`parent`，也不启用同步动态。
//! 回复一级评论时 `root = parent = 一级 rpid`；回复楼中楼的某条回复时 `parent`
//! 为该回复 rpid，正文加 `回复 @昵称 : ` 前缀（对照 PiliPlus `reply_new/view.dart`）。

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use reqwest::Client;
use serde_json::Value;

use crate::account::cookie_header_value;
use crate::danmu_rs::bilibili::{cookie_value, has_send_credentials};
use crate::error::{AppError, AppResult};

const SEND_COMMENT_URL: &str = "https://api.bilibili.com/x/v2/reply/add";
/// 与 Web 文本框保持一致，按 UTF-16 码元保守限制为 1000。
const MAX_COMMENT_UTF16_UNITS: usize = 1000;
static PENDING_COMMENTS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

pub(super) fn error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(code, message).with_site("bilibili")
}

pub(super) fn unknown_result() -> AppError {
    // 写入超时也可能已送达，不能设置自动重试提示。
    error(
        "video_comment_send_unknown",
        "评论发送状态未知，请先刷新评论区确认是否已送达，不要立即重复发送",
    )
}

/// 登录失效是评论写入与点赞共用的分类，错误码与措辞必须一致。
pub(super) fn login_expired() -> AppError {
    error(
        "video_comment_login_expired",
        "B站登录已失效，请在设置 → 账号重新登录",
    )
}

/// 风控限流也共用同一错误码；具体动作由调用方在文案里区分。
pub(super) fn limited(message: impl Into<String>) -> AppError {
    error("video_comment_send_limited", message)
}

pub(super) fn normalize_aid(aid: &str) -> AppResult<String> {
    let aid = aid.trim();
    let parsed = aid.parse::<u64>().ok().filter(|value| *value > 0);
    if !aid.bytes().all(|byte| byte.is_ascii_digit()) || parsed.is_none() {
        return Err(error("video_comment_invalid_aid", "B站稿件 aid 无效"));
    }
    Ok(parsed.unwrap().to_string())
}

fn normalize_message(message: &str) -> AppResult<&str> {
    let message = message.trim();
    if message.is_empty() {
        return Err(error("video_comment_empty", "请输入评论内容"));
    }
    if message.encode_utf16().count() > MAX_COMMENT_UTF16_UNITS {
        return Err(error("video_comment_too_long", "评论不能超过 1000 字符"));
    }
    if message
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(error(
            "video_comment_invalid_text",
            "评论含有不支持的控制字符",
        ));
    }
    Ok(message)
}

/// 昵称只用于拼回复前缀；B站昵称远短于此，上限只防异常输入撑大正文。
const MAX_PARENT_UNAME_CHARS: usize = 64;

/// 归一后的回复目标；`prefix` 仅在回复二级回复时存在。
#[derive(Debug, PartialEq, Eq)]
pub struct ReplyTarget {
    root: i64,
    parent: i64,
    prefix: Option<String>,
}

fn invalid_reply() -> AppError {
    error(
        "video_comment_invalid_reply",
        "回复目标无效，请刷新评论区后重试",
    )
}

/// 三者都缺省为一级评论；只有 `root` 时视为回复一级评论（`parent = root`）。
pub fn normalize_reply(
    root: Option<i64>,
    parent: Option<i64>,
    parent_uname: Option<&str>,
) -> AppResult<Option<ReplyTarget>> {
    let root = match (root, parent) {
        (None, None) => return Ok(None),
        (None, Some(_)) => return Err(invalid_reply()),
        (Some(root), _) => root,
    };
    let parent = parent.unwrap_or(root);
    if root <= 0 || parent <= 0 {
        return Err(invalid_reply());
    }
    if parent == root {
        return Ok(Some(ReplyTarget {
            root,
            parent,
            prefix: None,
        }));
    }
    let uname = parent_uname.map(str::trim).unwrap_or_default();
    if uname.is_empty()
        || uname.chars().count() > MAX_PARENT_UNAME_CHARS
        || uname.chars().any(char::is_control)
    {
        return Err(invalid_reply());
    }
    Ok(Some(ReplyTarget {
        root,
        parent,
        prefix: Some(format!("回复 @{uname} : ")),
    }))
}

/// 跨窗口也不允许对同一稿件并发提交；取消/异常返回时自动释放，不持锁跨 await。
struct PendingComment<'a> {
    pending: &'a Mutex<HashSet<String>>,
    aid: String,
}

impl<'a> PendingComment<'a> {
    fn reserve(pending: &'a Mutex<HashSet<String>>, aid: &str) -> AppResult<Self> {
        let inserted = pending
            .lock()
            .map_err(|_| error("video_comment_send_busy", "评论正在发送，请稍后再试"))?
            .insert(aid.to_owned());
        if !inserted {
            return Err(error(
                "video_comment_send_busy",
                "评论正在发送，请勿重复提交",
            ));
        }
        Ok(Self {
            pending,
            aid: aid.to_owned(),
        })
    }
}

impl Drop for PendingComment<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.aid);
        }
    }
}

/// client 必须由 `build_no_redirect_client` 创建，防止写入携带的凭据被重定向泄漏。
pub async fn send_comment(
    client: &Client,
    cookie: &str,
    aid: &str,
    message: &str,
    reply: Option<ReplyTarget>,
) -> AppResult<()> {
    send_comment_to_url(client, cookie, aid, message, reply, SEND_COMMENT_URL).await
}

async fn send_comment_to_url(
    client: &Client,
    cookie: &str,
    aid: &str,
    message: &str,
    reply: Option<ReplyTarget>,
    url: &str,
) -> AppResult<()> {
    let aid = normalize_aid(aid)?;
    // 1000 码元上限只计用户正文，与 Web 文本框和 PiliPlus 一致；前缀由这里追加。
    let message = normalize_message(message)?;
    let message = match reply.as_ref().and_then(|reply| reply.prefix.as_deref()) {
        Some(prefix) => format!("{prefix}{message}"),
        None => message.to_owned(),
    };
    let cookie = cookie_header_value(cookie)
        .filter(|cookie| has_send_credentials(cookie))
        .ok_or_else(|| {
            error(
                "video_comment_login_required",
                "请先在设置 → 账号登录 B站 Web 账号，或保存含 SESSDATA 和 bili_jct 的 Cookie",
            )
        })?;
    let csrf = cookie_value(cookie, "bili_jct").unwrap_or_default();
    let _pending = PendingComment::reserve(&PENDING_COMMENTS, &aid)?;
    let mut form = vec![
        ("type", "1".to_owned()),
        ("oid", aid.clone()),
        ("message", message),
        ("csrf", csrf),
    ];
    if let Some(reply) = &reply {
        form.push(("root", reply.root.to_string()));
        form.push(("parent", reply.parent.to_string()));
    }
    let response = client
        .post(url)
        .header("user-agent", super::DEFAULT_USER_AGENT)
        .header("referer", format!("https://www.bilibili.com/video/av{aid}"))
        .header("origin", super::VIDEO_REFERER)
        .header("cookie", cookie)
        .form(&form)
        .send()
        .await
        .map_err(|_| unknown_result())?;
    match response.status().as_u16() {
        200..=299 => {}
        401 => return Err(login_expired()),
        412 | 429 => {
            return Err(limited("B站暂时限制评论发送，请稍后再试"));
        }
        500..=599 => return Err(unknown_result()),
        _ => {
            return Err(error(
                "video_comment_send_rejected",
                "B站未接受评论，请检查账号状态或评论区限制",
            ));
        }
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| unknown_result())?;
    parse_send_result(&value)
}

fn parse_send_result(value: &Value) -> AppResult<()> {
    match value.get("code").and_then(Value::as_i64) {
        // 与 PiliPlus 一样：code=0 即视为提交成功。缺少 reply 详情不能诱导重复发送。
        Some(0) => Ok(()),
        Some(-101 | -111) => Err(login_expired()),
        Some(-102) => Err(error(
            "video_comment_permission",
            "账号权限不足，暂时无法发表评论",
        )),
        Some(-412) => Err(limited("B站暂时限制评论发送，请稍后再试")),
        Some(code) => Err(error(
            "video_comment_send_rejected",
            format!("B站未接受评论（错误码 {code}），请检查评论区限制或修改内容"),
        )),
        None => Err(unknown_result()),
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    pub(crate) fn response_server(
        status: &str,
        body: &str,
        headers: &str,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/reply/add", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let size = stream.read(&mut buffer).unwrap();
                assert!(size > 0);
                request.extend_from_slice(&buffer[..size]);
                let text = String::from_utf8_lossy(&request);
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse().ok())
                        })
                        .unwrap();
                    if body.len() >= length {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (url, server)
    }

    pub(crate) fn client() -> Client {
        crate::http_client::build_no_redirect_client(&crate::proxy::ProxyRoute::Direct).unwrap()
    }

    #[test]
    fn validates_aid_and_multiline_text_before_writing() {
        assert_eq!(normalize_aid(" 00042 ").unwrap(), "42");
        for aid in [
            "",
            "0",
            "-1",
            "+2",
            "BV1x",
            "1&oid=2",
            "18446744073709551616",
        ] {
            assert!(normalize_aid(aid).is_err(), "{aid}");
        }
        assert_eq!(
            normalize_message("  中文\n第二行 😀  ").unwrap(),
            "中文\n第二行 😀"
        );
        assert!(normalize_message(" \n\t　").is_err());
        assert!(normalize_message("a\0b").is_err());
        assert!(normalize_message(&"中".repeat(1000)).is_ok());
        assert!(normalize_message(&"中".repeat(1001)).is_err());
        assert!(normalize_message(&"😀".repeat(500)).is_ok());
        assert!(normalize_message(&"😀".repeat(501)).is_err());
    }

    #[test]
    fn pending_gate_rejects_duplicates_and_releases_on_drop() {
        let pending = Mutex::new(HashSet::new());
        let first = PendingComment::reserve(&pending, "42").unwrap();
        assert!(PendingComment::reserve(&pending, "42").is_err());
        assert!(PendingComment::reserve(&pending, "43").is_ok());
        drop(first);
        assert!(PendingComment::reserve(&pending, "42").is_ok());
    }

    #[tokio::test]
    async fn posts_only_authenticated_top_level_text_form() {
        let (url, server) = response_server("200 OK", r#"{"code":0,"data":{"reply":null}}"#, "");
        send_comment_to_url(
            &client(),
            "Cookie: SESSDATA=session; bili_jct=csrf-token",
            "123",
            "  你好\n世界 & =  ",
            None,
            &url,
        )
        .await
        .unwrap();
        let request = server.join().unwrap();
        let (head, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("POST /reply/add HTTP/1.1"));
        let head = head.to_ascii_lowercase();
        assert!(head.contains("cookie: sessdata=session; bili_jct=csrf-token"));
        assert!(head.contains("content-type: application/x-www-form-urlencoded"));
        assert!(head.contains("referer: https://www.bilibili.com/video/av123"));
        assert!(head.contains("origin: https://www.bilibili.com"));
        let form: std::collections::BTreeMap<_, _> =
            reqwest::Url::parse(&format!("http://localhost/?{body}"))
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
        assert_eq!(form.len(), 4);
        assert_eq!(form["type"], "1");
        assert_eq!(form["oid"], "123");
        assert_eq!(form["message"], "你好\n世界 & =");
        assert_eq!(form["csrf"], "csrf-token");
    }

    pub(crate) fn sent_form(request: &str) -> std::collections::BTreeMap<String, String> {
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
        reqwest::Url::parse(&format!("http://localhost/?{body}"))
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    // 同稿件并发锁是进程级的，并行测试各用不同 aid，否则会互相撞上 busy。
    #[tokio::test]
    async fn reply_to_root_comment_posts_root_and_parent_without_prefix() {
        let (url, server) = response_server("200 OK", r#"{"code":0}"#, "");
        let reply = normalize_reply(Some(42), Some(42), Some("忽略")).unwrap();
        send_comment_to_url(
            &client(),
            "SESSDATA=session; bili_jct=csrf",
            "124",
            " 同意 ",
            reply,
            &url,
        )
        .await
        .unwrap();
        let form = sent_form(&server.join().unwrap());
        assert_eq!(form.len(), 6);
        assert_eq!(form["root"], "42");
        assert_eq!(form["parent"], "42");
        assert_eq!(form["message"], "同意");
    }

    #[tokio::test]
    async fn reply_to_nested_reply_prefixes_uname() {
        let (url, server) = response_server("200 OK", r#"{"code":0}"#, "");
        let reply = normalize_reply(Some(42), Some(77), Some(" 路人甲 ")).unwrap();
        send_comment_to_url(
            &client(),
            "SESSDATA=session; bili_jct=csrf",
            "125",
            "说得对",
            reply,
            &url,
        )
        .await
        .unwrap();
        let form = sent_form(&server.join().unwrap());
        assert_eq!(form.len(), 6);
        assert_eq!(form["root"], "42");
        assert_eq!(form["parent"], "77");
        assert_eq!(form["message"], "回复 @路人甲 : 说得对");
    }

    #[test]
    fn invalid_reply_targets_are_rejected() {
        assert_eq!(normalize_reply(None, None, Some("x")).unwrap(), None);
        assert_eq!(
            normalize_reply(Some(5), None, None).unwrap(),
            Some(ReplyTarget {
                root: 5,
                parent: 5,
                prefix: None
            })
        );
        for (root, parent, uname) in [
            (None, Some(5), Some("x")),
            (Some(0), None, None),
            (Some(-1), Some(-1), None),
            (Some(5), Some(0), Some("x")),
            (Some(5), Some(6), None),
            (Some(5), Some(6), Some("  ")),
            (Some(5), Some(6), Some("a\nb")),
        ] {
            let err = normalize_reply(root, parent, uname).unwrap_err();
            assert_eq!(
                err.code, "video_comment_invalid_reply",
                "{root:?} {parent:?}"
            );
        }
        let long = "名".repeat(MAX_PARENT_UNAME_CHARS + 1);
        assert!(normalize_reply(Some(5), Some(6), Some(&long)).is_err());
    }

    #[tokio::test]
    async fn missing_or_invalid_cookie_never_reaches_network() {
        for cookie in [
            "",
            "SESSDATA=secret",
            "bili_jct=csrf",
            "SESSDATA=secret; bili_jct=csrf\nInjected: value",
        ] {
            let result =
                send_comment_to_url(&client(), cookie, "456", "测试", None, "http://127.0.0.1:1")
                    .await
                    .unwrap_err();
            assert_eq!(result.code, "video_comment_login_required");
            assert!(!result.message.contains("secret"));
        }
    }

    #[test]
    fn classifies_login_failure_and_unknown_result_without_exposing_response() {
        for code in [-101, -111] {
            let err = parse_send_result(&serde_json::json!({"code":code})).unwrap_err();
            assert_eq!(err.code, "video_comment_login_expired");
        }
        for value in [
            serde_json::json!({}),
            serde_json::json!({"message":"secret"}),
        ] {
            let err = parse_send_result(&value).unwrap_err();
            assert_eq!(err.code, "video_comment_send_unknown");
            assert!(!err.retryable);
            assert!(!err.message.contains("secret"));
        }
        assert!(parse_send_result(&serde_json::json!({"code": 0})).is_ok());
        assert_eq!(
            parse_send_result(&serde_json::json!({"code":12025,"message":"secret"}))
                .unwrap_err()
                .code,
            "video_comment_send_rejected"
        );
    }

    #[tokio::test]
    async fn redirects_are_not_followed_and_unknown_results_are_not_retried() {
        for (status, body, headers, expected) in [
            (
                "302 Found",
                "",
                "Location: http://127.0.0.1:1/leak\r\n",
                "video_comment_send_rejected",
            ),
            (
                "429 Too Many Requests",
                "",
                "",
                "video_comment_send_limited",
            ),
            (
                "500 Internal Server Error",
                "",
                "",
                "video_comment_send_unknown",
            ),
            ("200 OK", "not json", "", "video_comment_send_unknown"),
        ] {
            let (url, server) = response_server(status, body, headers);
            let err = send_comment_to_url(
                &client(),
                "SESSDATA=session; bili_jct=csrf",
                "789",
                "测试",
                None,
                &url,
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, expected);
            assert!(!err.retryable);
            server.join().unwrap();
        }
    }
}
