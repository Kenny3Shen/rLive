//! Twitch 公开 Web 引导、上下文缓存与 GraphQL 请求。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::error::{AppError, AppResult};

use super::TwitchSite;

const TWITCH_WEB_ROOT: &str = "https://www.twitch.tv/";
const TWITCH_GQL_URL: &str = "https://gql.twitch.tv/gql";
const CONTEXT_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// 为 Web 引导与 HLS CDN 保持稳定的类浏览器 UA。它不标识账号，
/// 也不绑定到脆弱的浏览器版本号。
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 当前 Twitch 公开 Web 的 GraphQL 客户端 id 内嵌在 HTML 引导文档中。
/// 它可能轮换，因此只保存在进程内存里。
#[derive(Clone)]
struct PublicWebContext {
    client_id: String,
    fetched_at: Instant,
}

static PUBLIC_WEB_CONTEXT: OnceLock<Mutex<Option<PublicWebContext>>> = OnceLock::new();

/// Twitch 的 Web 客户端在每个 GraphQL 请求中都发送设备标识符。省略它会把调用方
/// 标记为未识别客户端，这是决定播放 token 是否被服务端拼接广告的信号之一。
/// 它是每个进程随机生成的取值：绝不持久化、不从机器信息派生、不标识任何账号。
static GQL_DEVICE_ID: OnceLock<String> = OnceLock::new();

fn gql_device_id() -> &'static str {
    GQL_DEVICE_ID.get_or_init(|| {
        // Twitch 自己的标识符是 32 位小写字母数字。
        const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
        let raw = uuid::Uuid::new_v4().as_u128();
        let mut id = String::with_capacity(32);
        let mut remaining = raw;
        for _ in 0..32 {
            let index = (remaining % ALPHABET.len() as u128) as usize;
            id.push(ALPHABET[index] as char);
            remaining /= ALPHABET.len() as u128;
            if remaining == 0 {
                remaining = uuid::Uuid::new_v4().as_u128();
            }
        }
        id
    })
}

impl TwitchSite {
    fn context_cache() -> &'static Mutex<Option<PublicWebContext>> {
        PUBLIC_WEB_CONTEXT.get_or_init(|| Mutex::new(None))
    }

    async fn public_web_context(&self) -> AppResult<PublicWebContext> {
        if let Some(context) = Self::context_cache()
            .lock()
            .map_err(|_| Self::parse_err("Twitch public context mutex poisoned"))?
            .as_ref()
            .filter(|context| context.fetched_at.elapsed() < CONTEXT_CACHE_TTL)
            .cloned()
        {
            return Ok(context);
        }

        let response = self
            .client
            .get(TWITCH_WEB_ROOT)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header(
                "accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
            .send()
            .await
            .map_err(|error| Self::err(format!("获取 Twitch 网页初始化信息失败: {error}")))?;
        let status = response.status();
        let html = response
            .text()
            .await
            .map_err(|error| Self::err(format!("读取 Twitch 网页初始化信息失败: {error}")))?;
        if !status.is_success() {
            return Err(Self::err(format!(
                "Twitch 网页初始化 HTTP {status}: {}",
                preview(&html)
            )));
        }

        let client_id = parse_public_client_id(&html).ok_or_else(|| {
            Self::parse_err("Twitch 网页未提供公共客户端标识，可能变更了网页初始化格式，请稍后重试")
        })?;
        let context = PublicWebContext {
            client_id,
            fetched_at: Instant::now(),
        };
        *Self::context_cache()
            .lock()
            .map_err(|_| Self::parse_err("Twitch public context mutex poisoned"))? =
            Some(context.clone());
        Ok(context)
    }

    pub(super) async fn ensure_public_web_context(&self) -> AppResult<()> {
        self.public_web_context().await.map(|_| ())
    }

    /// 一次匿名 Web 访问式的 GraphQL POST：
    /// 请求头与 text/plain 内容类型都对齐 Twitch 自己的引导请求。
    async fn post_gql(&self, body: &Value) -> AppResult<Value> {
        let context = self.public_web_context().await?;
        let response = self
            .client
            .post(TWITCH_GQL_URL)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", TWITCH_WEB_ROOT)
            .header("client-id", context.client_id)
            .header("x-device-id", gql_device_id())
            .header("content-type", "text/plain; charset=UTF-8")
            .json(body)
            .send()
            .await
            .map_err(|error| Self::err(format!("Twitch GraphQL 请求失败: {error}")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| Self::err(format!("读取 Twitch GraphQL 响应失败: {error}")))?;
        if !status.is_success() {
            return Err(Self::err(format!(
                "Twitch GraphQL HTTP {status}: {}",
                preview(&text)
            )));
        }
        serde_json::from_str(&text)
            .map_err(|error| Self::parse_err(format!("Twitch GraphQL JSON 解析失败: {error}")))
    }

    pub(super) async fn graphql(
        &self,
        operation_name: &str,
        query: &str,
        variables: Value,
    ) -> AppResult<Value> {
        let value = self
            .post_gql(&json!({
                "operationName": operation_name,
                "query": query,
                "variables": variables,
            }))
            .await?;
        if let Some(error) = graphql_error(&value) {
            return Err(error);
        }
        value
            .get("data")
            .cloned()
            .ok_or_else(|| Self::parse_err("Twitch GraphQL 响应缺少 data"))
    }
}

fn parse_public_client_id(html: &str) -> Option<String> {
    // 当前公开的 Twitch 引导使用 `clientId="..."` 赋值形式。第二个标记用于处理等价
    // 的对象字面量形式，而不会把页面里的任意取值当作客户端 id。
    ["clientId=\"", "clientId:\""].iter().find_map(|marker| {
        let rest = html.split_once(marker)?.1;
        let candidate = rest.split('"').next()?.trim();
        (candidate.len() >= 16
            && candidate.len() <= 96
            && candidate
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
        .then(|| candidate.to_string())
    })
}

fn graphql_error(value: &Value) -> Option<AppError> {
    let errors = value.get("errors").and_then(Value::as_array);
    let challenge = value
        .pointer("/extensions/challenge/type")
        .and_then(Value::as_str)
        .or_else(|| {
            errors.into_iter().flatten().find_map(|error| {
                (error.pointer("/extensions/code").and_then(Value::as_str)
                    == Some("IntegrityCheckFailed")
                    || error
                        .pointer("/extensions/challenge/type")
                        .and_then(Value::as_str)
                        == Some("integrity"))
                .then_some("integrity")
            })
        });
    if challenge == Some("integrity") {
        return Some(
            AppError::new(
                "twitch_integrity_challenge",
                "Twitch 拒绝了受浏览器完整性保护的 GraphQL 请求，请稍后重试",
            )
            .with_site("twitch")
            .retryable(),
        );
    }
    let first = errors?.first()?;
    let message = first
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown Twitch GraphQL error");
    Some(TwitchSite::err(format!("Twitch GraphQL 错误: {message}")))
}

pub(super) fn preview(value: &str) -> String {
    value.chars().take(180).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_only_valid_public_client_id_from_bootstrap() {
        let html = r#"<script>var clientId="kimne78kx3ncx6brgo4mv6wki5h1ko"</script>"#;
        assert_eq!(
            parse_public_client_id(html).as_deref(),
            Some("kimne78kx3ncx6brgo4mv6wki5h1ko")
        );
        assert!(parse_public_client_id(r#"clientId="<script>"#).is_none());
    }

    #[test]
    fn recognizes_integrity_challenge_without_bypass() {
        let value = json!({
            "errors": [{
                "message": "failed integrity check",
                "extensions": { "code": "IntegrityCheckFailed" }
            }],
            "extensions": { "challenge": { "type": "integrity" } }
        });
        let error = graphql_error(&value).expect("must map challenge");
        assert_eq!(error.code, "twitch_integrity_challenge");
        assert!(error.retryable);
    }

    #[test]
    fn recognizes_integrity_challenge_after_another_graphql_error() {
        let value = json!({
            "errors": [
                { "message": "partial warning" },
                {
                    "message": "failed integrity check",
                    "extensions": { "code": "IntegrityCheckFailed" }
                }
            ],
            "data": { "streams": null }
        });
        let error = graphql_error(&value).expect("must map challenge");
        assert_eq!(error.code, "twitch_integrity_challenge");
        assert!(error.retryable);
    }
}
