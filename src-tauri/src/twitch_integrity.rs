//! Browser-backed Twitch cursor requests.
//!
//! Twitch validates cursor pagination against more than a copied integrity
//! header. The challenge and the protected GraphQL request therefore run in
//! the same isolated hidden WebView. Rust sends only the operation text and
//! variables into that WebView and receives the JSON response; challenge
//! tokens and browser cookies never leave the WebView or reach persistent
//! storage.
//!
//! The WebView reports back over a loopback HTTP endpoint owned by this
//! module: the injected script POSTs each message to
//! `http://127.0.0.1:<port>/twitch-bridge` in a single request. A
//! `document.title`-based channel was tried first and is deliberately gone:
//! the Twitch SPA rewrites the title at will, so multi-chunk title messages
//! lost fragments and every failure degraded into a timeout. The endpoint is
//! not the opt-in `web_bridge` server (that one exposes the whole command API
//! and must stay off unless the user enables it); this listener accepts only
//! bridge messages carrying the current random session id.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};

const WINDOW_LABEL: &str = "twitch-integrity";
const BRIDGE_PATH: &str = "/twitch-bridge";
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(45);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const EXPIRY_MARGIN_MS: u64 = 60_000;
/// Injected `window.__rliveTwitchGraphql` missing when the eval ran: the
/// initialization script was not (yet) applied to the current document.
const STATUS_BRIDGE_MISSING: u16 = 598;

#[derive(Debug, Clone)]
struct BrowserSession {
    id: String,
    proxy: Option<String>,
    expires_at_ms: u64,
}

#[derive(Default)]
struct Inner {
    app: OnceLock<tauri::AppHandle>,
    bridge_port: OnceLock<u16>,
    active_session_id: Mutex<Option<String>>,
    active_proxy: Mutex<Option<String>>,
    session: Mutex<Option<BrowserSession>>,
    pending: Mutex<HashMap<String, oneshot::Sender<BrowserResult>>>,
    changed: tokio::sync::Notify,
    gate: tokio::sync::Mutex<()>,
}

#[derive(Clone, Default)]
struct TwitchIntegrityManager(Arc<Inner>);

#[derive(Debug)]
struct BrowserResult {
    status: u16,
    body: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum BrowserMessage {
    Ready {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "expiresAtMs")]
        expires_at_ms: u64,
    },
    Result {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        status: u16,
        body: String,
    },
}

static MANAGER: OnceLock<TwitchIntegrityManager> = OnceLock::new();

pub(crate) fn install(app: tauri::AppHandle) {
    let manager = MANAGER.get_or_init(TwitchIntegrityManager::default);
    let _ = manager.0.app.set(app);
}

pub(crate) async fn graphql(proxy: Option<&str>, payload: Value) -> AppResult<Value> {
    MANAGER
        .get_or_init(TwitchIntegrityManager::default)
        .graphql(proxy.map(str::to_owned), payload)
        .await
}

impl TwitchIntegrityManager {
    async fn graphql(&self, proxy: Option<String>, payload: Value) -> AppResult<Value> {
        let _gate = self.0.gate.lock().await;
        for attempt in 0..2 {
            self.ensure_session(proxy.clone()).await?;
            let value = match self.request(payload.clone()).await {
                Ok(value) => value,
                Err(error) => {
                    self.invalidate_session();
                    if attempt == 0 {
                        continue;
                    }
                    return Err(error);
                }
            };
            if !contains_integrity_error(&value) {
                return Ok(value);
            }
            self.invalidate_session();
            if attempt > 0 {
                break;
            }
        }
        Err(integrity_error(
            "Twitch 浏览器完整性上下文自动刷新后仍未通过，请稍后重试",
        ))
    }

    async fn ensure_session(&self, proxy: Option<String>) -> AppResult<()> {
        if self.session_is_valid(proxy.as_deref())? {
            return Ok(());
        }

        #[cfg(any(target_os = "android", target_os = "ios"))]
        return Err(integrity_error(
            "当前移动平台无法创建 Twitch 完整性验证 WebView，暂时只能浏览首屏",
        ));

        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        self.create_desktop_session(proxy).await
    }

    fn session_is_valid(&self, proxy: Option<&str>) -> AppResult<bool> {
        let app = self.0.app.get();
        let window_exists = app.is_some_and(|app| {
            use tauri::Manager;
            app.get_webview_window(WINDOW_LABEL).is_some()
        });
        let now = unix_millis();
        let active_session_id = self
            .0
            .active_session_id
            .lock()
            .map_err(|_| integrity_error("Twitch 完整性验证状态暂不可用"))?
            .clone();
        let mut session = self
            .0
            .session
            .lock()
            .map_err(|_| integrity_error("Twitch 完整性验证状态暂不可用"))?;
        let valid = window_exists
            && session.as_ref().is_some_and(|session| {
                active_session_id.as_deref() == Some(session.id.as_str())
                    && session.proxy.as_deref() == proxy
                    && session.expires_at_ms > now.saturating_add(EXPIRY_MARGIN_MS)
            });
        if !valid {
            *session = None;
        }
        Ok(valid)
    }

    /// Starts the loopback callback listener once per process and returns its
    /// port. Callers are already serialized through `gate`, so the get/set
    /// pair on `bridge_port` cannot race.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    async fn ensure_bridge_port(&self) -> AppResult<u16> {
        if let Some(port) = self.0.bridge_port.get() {
            return Ok(*port);
        }
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| integrity_error(format!("启动 Twitch 完整性回传监听失败: {error}")))?;
        let port = listener
            .local_addr()
            .map_err(|error| integrity_error(format!("读取 Twitch 完整性回传端口失败: {error}")))?
            .port();
        let inner = self.0.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((stream, _peer)) = listener.accept().await else {
                    continue;
                };
                let inner = inner.clone();
                tauri::async_runtime::spawn(async move {
                    serve_callback(stream, inner).await;
                });
            }
        });
        let _ = self.0.bridge_port.set(port);
        Ok(port)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    async fn create_desktop_session(&self, proxy: Option<String>) -> AppResult<()> {
        use tauri::Manager;

        let app = self.0.app.get().cloned().ok_or_else(|| {
            integrity_error("Twitch 完整性验证 WebView 尚未完成初始化，请稍后重试")
        })?;
        if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
            let _ = existing.destroy();
        }
        if let Ok(mut session) = self.0.session.lock() {
            *session = None;
        }

        let port = self.ensure_bridge_port().await?;
        let session_id = uuid::Uuid::new_v4().simple().to_string();
        if let Ok(mut active_session_id) = self.0.active_session_id.lock() {
            *active_session_id = Some(session_id.clone());
        }
        if let Ok(mut active_proxy) = self.0.active_proxy.lock() {
            *active_proxy = proxy.clone();
        }
        let session_id_json = serde_json::to_string(&session_id)
            .map_err(|_| integrity_error("创建 Twitch 完整性验证会话失败"))?;
        let init_script = INTEGRITY_BRIDGE_SCRIPT
            .replace("__RLIVE_SESSION_ID__", &session_id_json)
            .replace("__RLIVE_BRIDGE_PORT__", &port.to_string());
        let url = "https://www.twitch.tv/directory/all"
            .parse()
            .map_err(|_| integrity_error("Twitch 完整性验证地址无效"))?;
        let mut builder =
            tauri::WebviewWindowBuilder::new(&app, WINDOW_LABEL, tauri::WebviewUrl::External(url))
                .title("Twitch")
                .inner_size(1280.0, 720.0)
                .visible(false)
                .skip_taskbar(true)
                .decorations(false)
                .incognito(true)
                .initialization_script(init_script)
                .on_navigation(|url| {
                    url.scheme() == "https"
                        && url
                            .host_str()
                            .is_some_and(|host| host == "twitch.tv" || host.ends_with(".twitch.tv"))
                });
        if let Some(proxy) = proxy.as_deref() {
            let proxy = proxy
                .parse()
                .map_err(|_| integrity_error("Twitch 完整性验证无法使用当前代理地址"))?;
            builder = builder.proxy_url(proxy);
        }
        builder.build().map_err(|error| {
            integrity_error(format!("创建 Twitch 完整性验证 WebView 失败: {error}"))
        })?;

        let deadline = tokio::time::Instant::now() + ACQUIRE_TIMEOUT;
        loop {
            if self.session_is_valid(proxy.as_deref())? {
                return Ok(());
            }
            let notified = self.0.changed.notified();
            if self.session_is_valid(proxy.as_deref())? {
                return Ok(());
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                tracing::warn!(
                    timeout_secs = ACQUIRE_TIMEOUT.as_secs(),
                    "twitch integrity ready message never arrived; the page may not have \
                     issued its integrity challenge"
                );
                self.invalidate_session();
                return Err(integrity_error(
                    "Twitch 浏览器完整性验证超时，请检查网络或代理后重试",
                ));
            }
        }
    }

    async fn request(&self, payload: Value) -> AppResult<Value> {
        use tauri::Manager;

        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let request_id_json = serde_json::to_string(&request_id)
            .map_err(|_| integrity_error("创建 Twitch 浏览器请求失败"))?;
        let payload_json = serde_json::to_string(&payload)
            .map_err(|_| integrity_error("序列化 Twitch 浏览器请求失败"))?;
        let session_id = self
            .0
            .session
            .lock()
            .map_err(|_| integrity_error("Twitch 完整性验证状态暂不可用"))?
            .as_ref()
            .map(|session| session.id.clone())
            .ok_or_else(|| integrity_error("Twitch 完整性验证会话不存在"))?;
        let session_id_json = serde_json::to_string(&session_id)
            .map_err(|_| integrity_error("创建 Twitch 浏览器请求失败"))?;
        let port = self
            .0
            .bridge_port
            .get()
            .copied()
            .ok_or_else(|| integrity_error("Twitch 完整性回传监听未启动"))?;
        let app = self
            .0
            .app
            .get()
            .ok_or_else(|| integrity_error("Twitch 完整性验证 WebView 尚未初始化"))?;
        let window = app
            .get_webview_window(WINDOW_LABEL)
            .ok_or_else(|| integrity_error("Twitch 完整性验证 WebView 已关闭"))?;
        let (sender, receiver) = oneshot::channel();
        self.0
            .pending
            .lock()
            .map_err(|_| integrity_error("Twitch 浏览器请求状态暂不可用"))?
            .insert(request_id.clone(), sender);

        // `eval` only enqueues the script; if the SPA navigated and the
        // initialization script is not applied yet, calling the bridge
        // function would throw and Rust would silently wait out the timeout.
        // The fallback branch reports that state through the same channel.
        let script = format!(
            "(() => {{ if (typeof window.__rliveTwitchGraphql === \"function\") {{ \
               window.__rliveTwitchGraphql({request_id_json}, {payload_json}); \
             }} else {{ \
               fetch(\"http://127.0.0.1:{port}{BRIDGE_PATH}\", {{ method: \"POST\", body: JSON.stringify({{ \
                 kind: \"result\", sessionId: {session_id_json}, requestId: {request_id_json}, \
                 status: {STATUS_BRIDGE_MISSING}, body: \"{{}}\" }}) }}).catch(() => {{}}); \
             }} }})();"
        );
        if let Err(error) = window.eval(&script) {
            self.remove_pending(&request_id);
            return Err(integrity_error(format!(
                "执行 Twitch 浏览器分页请求失败: {error}"
            )));
        }

        let result = match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                return Err(integrity_error("Twitch 浏览器分页请求意外中断"));
            }
            Err(_) => {
                tracing::warn!(
                    timeout_secs = REQUEST_TIMEOUT.as_secs(),
                    "twitch integrity graphql eval produced no callback before the deadline"
                );
                self.remove_pending(&request_id);
                return Err(integrity_error("Twitch 浏览器分页请求超时，请稍后重试"));
            }
        };
        if result.status == STATUS_BRIDGE_MISSING {
            tracing::warn!(
                "twitch integrity bridge script was not injected into the current document"
            );
            return Err(integrity_error(
                "Twitch 完整性桥接脚本未注入当前页面，正在重建上下文",
            ));
        }
        if !(200..300).contains(&result.status) {
            return Err(integrity_error(format!(
                "Twitch 浏览器分页请求 HTTP {}",
                result.status
            )));
        }
        serde_json::from_str(&result.body)
            .map_err(|error| integrity_error(format!("Twitch 浏览器响应解析失败: {error}")))
    }

    fn remove_pending(&self, request_id: &str) {
        if let Ok(mut pending) = self.0.pending.lock() {
            pending.remove(request_id);
        }
    }

    fn invalidate_session(&self) {
        if let Some(app) = self.0.app.get() {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let _ = window.destroy();
            }
        }
        if let Ok(mut session) = self.0.session.lock() {
            *session = None;
        }
        if let Ok(mut active_session_id) = self.0.active_session_id.lock() {
            *active_session_id = None;
        }
        if let Ok(mut active_proxy) = self.0.active_proxy.lock() {
            *active_proxy = None;
        }
    }
}

/// One callback connection: parse the request, accept only a bridge message
/// POST, and answer with the CORS headers the Twitch-origin `fetch` needs to
/// observe success.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn serve_callback(mut stream: tokio::net::TcpStream, inner: Arc<Inner>) {
    use crate::web_bridge::http::{read_request, write_json};

    const READ_TIMEOUT: Duration = Duration::from_secs(10);

    let request = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        _ => {
            let _ = write_json(
                &mut stream,
                400,
                "Bad Request",
                "{\"error\":\"bad request\"}",
            )
            .await;
            return;
        }
    };
    let path = request.path.split(['?', '#']).next().unwrap_or_default();
    if request.method != "POST" || path != BRIDGE_PATH {
        let _ = write_json(&mut stream, 404, "Not Found", "{\"error\":\"not found\"}").await;
        return;
    }
    let Ok(message) = serde_json::from_slice::<BrowserMessage>(&request.body) else {
        let _ = write_json(
            &mut stream,
            400,
            "Bad Request",
            "{\"error\":\"bad message\"}",
        )
        .await;
        return;
    };
    handle_message(&inner, message);
    let _ = write_json(&mut stream, 200, "OK", "{\"ok\":true}").await;
}

/// Applies one bridge message. The random session id doubles as the
/// authenticator: the listener is loopback-only and a message whose session id
/// is not the currently active one (a stale WebView generation, or any other
/// local process guessing) is dropped.
fn handle_message(inner: &Arc<Inner>, message: BrowserMessage) {
    let is_active = |session_id: &str| {
        inner
            .active_session_id
            .lock()
            .ok()
            .is_some_and(|active| active.as_deref() == Some(session_id))
    };
    match message {
        BrowserMessage::Ready {
            session_id,
            expires_at_ms,
        } => {
            if !is_active(&session_id) || expires_at_ms <= unix_millis() {
                return;
            }
            let proxy = inner
                .active_proxy
                .lock()
                .ok()
                .and_then(|proxy| proxy.clone());
            if let Ok(mut session) = inner.session.lock() {
                *session = Some(BrowserSession {
                    id: session_id,
                    proxy,
                    expires_at_ms,
                });
                inner.changed.notify_waiters();
            }
        }
        BrowserMessage::Result {
            session_id,
            request_id,
            status,
            body,
        } => {
            if !is_active(&session_id) {
                return;
            }
            if let Ok(mut pending) = inner.pending.lock()
                && let Some(sender) = pending.remove(&request_id)
            {
                let _ = sender.send(BrowserResult { status, body });
            }
        }
    }
}

/// Shared with `sites::twitch`: both the browser path and the plain HTTP path
/// need to recognize an integrity rejection inside an otherwise 200 response.
pub(crate) fn contains_integrity_error(value: &Value) -> bool {
    let mut envelopes: Box<dyn Iterator<Item = &Value> + '_> = match value.as_array() {
        Some(values) => Box::new(values.iter()),
        None => Box::new(std::iter::once(value)),
    };
    envelopes.any(|envelope| {
        envelope
            .pointer("/extensions/challenge/type")
            .and_then(Value::as_str)
            == Some("integrity")
            || envelope
                .get("errors")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|error| {
                    error.pointer("/extensions/code").and_then(Value::as_str)
                        == Some("IntegrityCheckFailed")
                        || error
                            .pointer("/extensions/challenge/type")
                            .and_then(Value::as_str)
                            == Some("integrity")
                })
    })
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn integrity_error(message: impl Into<String>) -> AppError {
    AppError::new("twitch_integrity_unavailable", message)
        .with_site("twitch")
        .retryable()
}

const INTEGRITY_BRIDGE_SCRIPT: &str = r#"
(() => {
  if (location.origin !== "https://www.twitch.tv" || window.__rliveTwitchBridge) return;
  window.__rliveTwitchBridge = true;
  const sessionId = __RLIVE_SESSION_ID__;
  const bridgeUrl = "http://127.0.0.1:__RLIVE_BRIDGE_PORT__/twitch-bridge";
  const originalFetch = window.fetch;
  let browserContext = null;

  // A bare POST body keeps this a CORS "simple request": no preflight, one
  // round trip. Retries cover a listener that is momentarily busy.
  const send = async value => {
    const body = JSON.stringify(value);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await originalFetch(bridgeUrl, { method: "POST", body });
        if (response.ok) return;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  };

  window.fetch = async function(input, init) {
    const response = await originalFetch.apply(this, arguments);
    try {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, location.href);
      if (url.origin === "https://gql.twitch.tv" && url.pathname === "/integrity") {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init && init.headers).forEach((value, key) => headers.set(key, value));
        response.clone().json().then(body => {
          browserContext = {
            clientId: headers.get("client-id") || "",
            deviceId: headers.get("x-device-id") || "",
            sessionId: headers.get("client-session-id") || "",
            clientVersion: headers.get("client-version") || "",
            token: body.token || "",
            expiresAtMs: Number(body.expiration) || 0
          };
          if (browserContext.clientId && browserContext.deviceId && browserContext.token) {
            send({ kind: "ready", sessionId, expiresAtMs: browserContext.expiresAtMs });
          }
        }).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  window.__rliveTwitchGraphql = async (requestId, payload) => {
    if (!browserContext) {
      send({ kind: "result", sessionId, requestId, status: 503, body: "{}" });
      return;
    }
    try {
      const response = await originalFetch("https://gql.twitch.tv/gql", {
        method: "POST",
        headers: {
          "client-id": browserContext.clientId,
          "client-integrity": browserContext.token,
          "x-device-id": browserContext.deviceId,
          "client-session-id": browserContext.sessionId,
          "client-version": browserContext.clientVersion,
          "content-type": "text/plain; charset=UTF-8"
        },
        body: JSON.stringify(payload)
      });
      send({ kind: "result", sessionId, requestId, status: response.status, body: await response.text() });
    } catch (error) {
      send({ kind: "result", sessionId, requestId, status: 599, body: JSON.stringify({ error: String(error) }) });
    }
  };

  let attempts = 0;
  const advanceDirectory = () => {
    const scroller = document.querySelector(".root-scrollable__content");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
    if (++attempts >= 40 || browserContext) clearInterval(timer);
  };
  const timer = setInterval(advanceDirectory, 900);
  addEventListener("DOMContentLoaded", advanceDirectory, { once: true });
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn message(value: &Value) -> BrowserMessage {
        serde_json::from_value(value.clone()).unwrap()
    }

    #[test]
    fn accepts_ready_message_for_the_active_session() {
        let inner = Arc::new(Inner::default());
        *inner.active_session_id.lock().unwrap() = Some("session-a".into());
        *inner.active_proxy.lock().unwrap() = Some("http://127.0.0.1:7890".into());
        let expiration = unix_millis() + 3_600_000;

        handle_message(
            &inner,
            message(&serde_json::json!({
                "kind": "ready",
                "sessionId": "session-a",
                "expiresAtMs": expiration,
            })),
        );

        let session = inner.session.lock().unwrap().clone().unwrap();
        assert_eq!(session.id, "session-a");
        assert_eq!(session.expires_at_ms, expiration);
        assert_eq!(session.proxy.as_deref(), Some("http://127.0.0.1:7890"));
    }

    #[test]
    fn rejects_ready_message_from_another_session() {
        let inner = Arc::new(Inner::default());
        *inner.active_session_id.lock().unwrap() = Some("session-a".into());
        handle_message(
            &inner,
            message(&serde_json::json!({
                "kind": "ready",
                "sessionId": "session-b",
                "expiresAtMs": unix_millis() + 3_600_000,
            })),
        );
        assert!(inner.session.lock().unwrap().is_none());
    }

    #[test]
    fn rejects_ready_message_from_a_destroyed_webview_generation() {
        let inner = Arc::new(Inner::default());
        *inner.active_session_id.lock().unwrap() = Some("session-new".into());
        handle_message(
            &inner,
            message(&serde_json::json!({
                "kind": "ready",
                "sessionId": "session-old",
                "expiresAtMs": unix_millis() + 3_600_000,
            })),
        );
        assert!(inner.session.lock().unwrap().is_none());
    }

    #[test]
    fn result_message_resolves_only_the_active_sessions_pending_request() {
        let inner = Arc::new(Inner::default());
        *inner.active_session_id.lock().unwrap() = Some("session-a".into());
        let (sender, mut receiver) = oneshot::channel();
        inner
            .pending
            .lock()
            .unwrap()
            .insert("request-1".into(), sender);

        handle_message(
            &inner,
            message(&serde_json::json!({
                "kind": "result",
                "sessionId": "session-b",
                "requestId": "request-1",
                "status": 200,
                "body": "{}",
            })),
        );
        assert!(receiver.try_recv().is_err());
        assert!(inner.pending.lock().unwrap().contains_key("request-1"));

        handle_message(
            &inner,
            message(&serde_json::json!({
                "kind": "result",
                "sessionId": "session-a",
                "requestId": "request-1",
                "status": 200,
                "body": "{\"data\":{}}",
            })),
        );
        let result = receiver.try_recv().unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.body, "{\"data\":{}}");
        assert!(inner.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn callback_endpoint_accepts_a_posted_ready_message() {
        let inner = Arc::new(Inner::default());
        *inner.active_session_id.lock().unwrap() = Some("session-a".into());
        let expiration = unix_millis() + 3_600_000;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = serde_json::json!({
            "kind": "ready",
            "sessionId": "session-a",
            "expiresAtMs": expiration,
        })
        .to_string();
        let client = tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
            let request = format!(
                "POST /twitch-bridge HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            response
        });

        let (stream, _) = listener.accept().await.unwrap();
        serve_callback(stream, inner.clone()).await;
        let response = client.await.unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Access-Control-Allow-Origin: *"));
        let session = inner.session.lock().unwrap().clone().unwrap();
        assert_eq!(session.id, "session-a");
        assert_eq!(session.expires_at_ms, expiration);
    }

    #[tokio::test]
    async fn callback_endpoint_rejects_other_paths() {
        let inner = Arc::new(Inner::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(b"POST /api/invoke/settings_get HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}")
                .await
                .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            response
        });

        let (stream, _) = listener.accept().await.unwrap();
        serve_callback(stream, inner).await;
        let response = client.await.unwrap();
        assert!(response.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn detects_twitch_integrity_error_response() {
        assert!(contains_integrity_error(&serde_json::json!([{
            "errors": [{
                "message": "failed integrity check",
                "extensions": { "code": "IntegrityCheckFailed" }
            }],
            "data": { "streams": null }
        }])));
        assert!(!contains_integrity_error(&serde_json::json!({
            "data": { "streams": { "edges": [] } }
        })));
        assert!(contains_integrity_error(&serde_json::json!({
            "errors": [{ "message": "challenge required" }],
            "extensions": { "challenge": { "type": "integrity" } }
        })));
    }
}
