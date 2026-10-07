//! 抖音 Cookie 的只读账号探针，不刷新或持久化上游返回的 Cookie。
//!
//! 只向第一方「当前用户」接口发送已保存凭据。公开推荐可匿名访问，
//! 不能用推荐成功或 Cookie 中存在 sessionid 作为登录有效的证据。

use reqwest::Client;
use reqwest::header::{ACCEPT, COOKIE, REFERER, USER_AGENT};
use serde_json::Value;

use super::{cookie_header_value, normalize_display_name};
use crate::sites::douyin::DEFAULT_USER_AGENT;

const PROFILE_URL: &str = "https://live.douyin.com/webcast/user/me/";
const REFERER_URL: &str = "https://live.douyin.com/";

#[derive(Debug, PartialEq)]
pub enum ProfileLookup {
    Valid(Option<String>),
    /// 仅 `20003`（User doesn't login）构成明确的未登录证据。
    Rejected,
    /// 网络失败、风控、未知业务码或异常结构都不得导致删除 Cookie。
    Unavailable,
}

pub async fn lookup(cookie: &str, route: &crate::proxy::ProxyRoute) -> ProfileLookup {
    // 不跟随跳转，避免把登录/验证页误当账号响应，也不向新目标重放凭据。
    let Ok(client) = crate::http_client::build_no_redirect_client(route) else {
        return ProfileLookup::Unavailable;
    };
    lookup_with_client(&client, PROFILE_URL, cookie).await
}

async fn lookup_with_client(client: &Client, url: &str, cookie: &str) -> ProfileLookup {
    let Some(cookie) = cookie_header_value(cookie) else {
        return ProfileLookup::Unavailable;
    };
    let Ok(response) = client
        .get(url)
        .query(&[("aid", "6383"), ("device_platform", "web")])
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(REFERER, REFERER_URL)
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(COOKIE, cookie)
        .send()
        .await
    else {
        return ProfileLookup::Unavailable;
    };
    // HTTP 401/403 也可能来自网关；只有正常 JSON 中的明确业务码才算失效。
    if !response.status().is_success() {
        return ProfileLookup::Unavailable;
    }
    let Ok(body) = response.text().await else {
        return ProfileLookup::Unavailable;
    };
    parse_profile(&body)
}

fn parse_profile(body: &str) -> ProfileLookup {
    let Ok(response) = serde_json::from_str::<Value>(body) else {
        return ProfileLookup::Unavailable;
    };
    match response.get("status_code").and_then(Value::as_i64) {
        Some(20003) => ProfileLookup::Rejected,
        Some(0) => {
            let Some(data) = response.get("data").filter(|data| data.is_object()) else {
                return ProfileLookup::Unavailable;
            };
            // 成功码本身不足以证明返回了当前账号；不把空对象/游客占位认作登录。
            let has_user_id = ["id_str", "id"].iter().any(|key| {
                data.get(key).is_some_and(|id| {
                    id.as_u64().is_some_and(|id| id > 0)
                        || id.as_str().is_some_and(|id| {
                            !id.is_empty()
                                && id.bytes().all(|byte| byte.is_ascii_digit())
                                && id.bytes().any(|byte| byte != b'0')
                        })
                })
            });
            if !has_user_id {
                return ProfileLookup::Unavailable;
            }
            // 昵称只是可选展示信息，缺失或不可展示不影响已确认的登录态。
            let username = data
                .get("nickname")
                .and_then(Value::as_str)
                .and_then(|name| normalize_display_name(name.to_owned()));
            ProfileLookup::Valid(username)
        }
        _ => ProfileLookup::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    use super::*;

    #[test]
    fn parses_current_user_with_string_or_numeric_id() {
        for body in [
            r#"{"status_code":0,"data":{"id_str":"1234567890123456789","nickname":" 抖音用户 "}}"#,
            r#"{"status_code":0,"data":{"id":1234567890123456789,"nickname":"抖音用户"}}"#,
        ] {
            assert_eq!(
                parse_profile(body),
                ProfileLookup::Valid(Some("抖音用户".into()))
            );
        }
    }

    #[test]
    fn confirmed_session_does_not_require_a_display_name() {
        for nickname in [
            Value::Null,
            Value::from(""),
            Value::from("bad\nname"),
            Value::from("字".repeat(129)),
        ] {
            let body = serde_json::json!({"status_code": 0, "data": {"id_str": "42", "nickname": nickname}});
            assert_eq!(parse_profile(&body.to_string()), ProfileLookup::Valid(None));
        }
        assert_eq!(
            parse_profile(r#"{"status_code":0,"data":{"id":42}}"#),
            ProfileLookup::Valid(None)
        );
    }

    #[test]
    fn only_explicit_not_logged_in_response_is_rejected() {
        // 第一方接口对匿名/失效会话的实际响应形态；不按自由文本猜测状态。
        assert_eq!(
            parse_profile(
                r#"{"data":{"message":"User doesn't login","prompts":"请登录后进入直播间"},"status_code":20003}"#
            ),
            ProfileLookup::Rejected
        );
        for body in [
            r#"{"status_code":101}"#,
            r#"{"status_code":444}"#,
            r#"{"status_code":2483}"#,
            r#"{"status_code":8}"#,
            r#"{"status_code":500,"message":"User doesn't login"}"#,
            r#"{"status_code":"20003"}"#,
            r#"{"data":{"id_str":"42","nickname":"名字"}}"#,
            r#"{"status_code":0}"#,
            r#"{"status_code":0,"data":null}"#,
            r#"{"status_code":0,"data":{}}"#,
            r#"{"status_code":0,"data":{"nickname":"游客","id_str":"0"}}"#,
            r#"{"status_code":0,"data":{"id":-1}}"#,
            r#"{"status_code":0,"data":{"id_str":"not-an-id"}}"#,
            "",
            "blocked",
            "<html>验证页面</html>",
        ] {
            assert_eq!(parse_profile(body), ProfileLookup::Unavailable, "{body}");
        }
    }

    #[tokio::test]
    async fn probe_sends_normalized_cookie_and_keeps_http_errors_unknown() {
        // 同一请求链覆盖成功、未登录、网关拒绝、跳转和验证页；所有凭据均为夹具。
        for (status, body, expected) in [
            (
                "200 OK",
                r#"{"status_code":0,"data":{"id_str":"42","nickname":"测试"}}"#,
                ProfileLookup::Valid(Some("测试".into())),
            ),
            (
                "200 OK",
                r#"{"status_code":20003}"#,
                ProfileLookup::Rejected,
            ),
            (
                "403 Forbidden",
                r#"{"status_code":20003}"#,
                ProfileLookup::Unavailable,
            ),
            (
                "429 Too Many Requests",
                r#"{"status_code":20003}"#,
                ProfileLookup::Unavailable,
            ),
            (
                "302 Found",
                r#"{"status_code":20003}"#,
                ProfileLookup::Unavailable,
            ),
            (
                "200 OK",
                "<html>verification</html>",
                ProfileLookup::Unavailable,
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 2048];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let length = stream.read(&mut buffer).unwrap();
                    assert!(length > 0);
                    request.extend_from_slice(&buffer[..length]);
                }
                let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(
                    request
                        .starts_with("get /webcast/user/me/?aid=6383&device_platform=web http/1.1")
                );
                assert!(request.contains("\r\ncookie: sessionid=fixture; ttwid=anonymous\r\n"));
                assert!(request.contains("\r\nreferer: https://live.douyin.com/\r\n"));
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nLocation: http://127.0.0.1:1/should-not-follow\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            });
            let client =
                crate::http_client::build_no_redirect_client(&crate::proxy::ProxyRoute::Direct)
                    .unwrap();
            let actual = lookup_with_client(
                &client,
                &format!("http://{address}/webcast/user/me/"),
                " cOoKiE: sessionid=fixture; ttwid=anonymous ",
            )
            .await;
            server.join().unwrap();
            assert_eq!(actual, expected);
        }
    }

    #[tokio::test]
    async fn malformed_cookie_or_network_failure_never_expires_a_session() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let url = format!("http://{address}/webcast/user/me/");
        for cookie in ["", "sessionid=bad\r\nInjected: value", "sessionid=fixture"] {
            assert_eq!(
                lookup_with_client(&client, &url, cookie).await,
                ProfileLookup::Unavailable
            );
        }
        assert_eq!(
            lookup(
                "sessionid=fixture",
                &crate::proxy::ProxyRoute::Custom("http://[".into()),
            )
            .await,
            ProfileLookup::Unavailable
        );
    }
}
