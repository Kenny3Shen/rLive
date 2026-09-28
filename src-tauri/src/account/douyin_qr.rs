//! 桌面端通过独立的抖音官网窗口登录。
//!
//! 官网负责二维码、访问验证及登录协议；rLive 不注入已保存凭据，也不向
//! 远程页面开放 IPC。只有第一方账号探针确认有效的新 Cookie 才允许落库。

use crate::account::qr::{QrLoginPoll, QrLoginStart, QrSite};
use crate::error::AppResult;

const SITE: QrSite = QrSite {
    id: "douyin",
    display: "抖音",
};
const LOGIN_URL: &str = "https://live.douyin.com/";
const COOKIE_URL: &str = "https://live.douyin.com/webcast/user/me/";
const WINDOW_PREFIX: &str = "douyin-login-";

#[cfg(desktop)]
pub use desktop::{cancel, cancel_all, finish, poll, start};

#[cfg(mobile)]
pub async fn start(_app: tauri::AppHandle, _proxy: Option<&str>) -> AppResult<QrLoginStart> {
    Err(SITE.error(
        "unsupported",
        "移动端暂不支持抖音官方登录窗口，请手动输入 Cookie",
    ))
}
#[cfg(mobile)]
pub async fn poll(_qr_key: &str) -> AppResult<QrLoginPoll> {
    Err(SITE.error("unsupported", "移动端请手动输入抖音 Cookie"))
}
#[cfg(mobile)]
pub fn cancel(_qr_key: &str) -> AppResult<()> {
    Ok(())
}
#[cfg(mobile)]
pub fn cancel_all() -> AppResult<()> {
    Ok(())
}
#[cfg(mobile)]
pub fn finish(_qr_key: &str, _save: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
    Err(SITE.error("unsupported", "移动端请手动输入抖音 Cookie"))
}

#[cfg(desktop)]
mod desktop {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use reqwest::Url;
    use tauri::webview::NewWindowResponse;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

    use super::*;
    use crate::account::{douyin_profile, qr};

    const LOGIN_TTL: Duration = Duration::from_secs(5 * 60);
    static SESSIONS: qr::QrSessionStore<Arc<BrowserSession>> = qr::QrSessionStore::new(SITE);

    struct BrowserSession {
        app: tauri::AppHandle,
        label: String,
        data_dir: PathBuf,
        proxy: Option<String>,
    }

    impl Drop for BrowserSession {
        fn drop(&mut self) {
            // 会话表 prune/clear 可能正持锁，窗口销毁必须推迟到锁外；
            // 不在窗口事件或 UI 主线程读取 Cookie、等待网络或清理文件。
            let app = self.app.clone();
            let label = self.label.clone();
            let data_dir = self.data_dir.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.destroy();
                }
                // WebView2 释放文件句柄可能稍晚于窗口销毁。隐私模式不持久化
                // 登录 Cookie；这里只尽力清掉独立目录中的浏览器缓存。
                for _ in 0..6 {
                    let directory = data_dir.clone();
                    let removed = tauri::async_runtime::spawn_blocking(move || {
                        std::fs::remove_dir_all(directory)
                            .map(|_| true)
                            .unwrap_or_else(|error| error.kind() == std::io::ErrorKind::NotFound)
                    })
                    .await
                    .unwrap_or(false);
                    if removed {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            });
        }
    }

    pub async fn start(app: tauri::AppHandle, proxy: Option<&str>) -> AppResult<QrLoginStart> {
        let proxy_url = browser_proxy(proxy)?;
        cancel_all()?;
        let qr_key = uuid::Uuid::new_v4().simple().to_string();
        let label = format!("{WINDOW_PREFIX}{qr_key}");
        let data_dir = app
            .path()
            .app_cache_dir()
            .map_err(|_| SITE.error("window", "无法取得登录窗口缓存目录"))?
            .join("douyin-login")
            .join(&qr_key);
        let session = Arc::new(BrowserSession {
            app: app.clone(),
            label: label.clone(),
            data_dir: data_dir.clone(),
            proxy: proxy.map(str::to_owned),
        });
        // 先注册再建窗：慢速建窗期间收到取消或刷新，迟到的窗口也会被回收。
        SESSIONS.insert(qr_key.clone(), Arc::clone(&session))?;
        let key_for_close = qr_key.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut builder = WebviewWindowBuilder::new(
                &app,
                &label,
                WebviewUrl::External(Url::parse(LOGIN_URL).expect("fixed login URL")),
            )
            .title("抖音官网登录 — 请点击登录并扫码")
            .inner_size(1100.0, 800.0)
            .min_inner_size(700.0, 600.0)
            .center()
            .incognito(true)
            .data_directory(data_dir)
            .on_navigation(is_allowed_navigation)
            .on_new_window(|_, _| NewWindowResponse::Deny);
            if let Some(proxy) = proxy_url {
                builder = builder.proxy_url(proxy);
            }
            let window = builder.build().map_err(|_| {
                SITE.error(
                    "window",
                    "无法打开抖音官方登录窗口，请重试或手动输入 Cookie",
                )
            })?;
            window.on_window_event(move |event| {
                if matches!(
                    event,
                    WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                ) {
                    // 不接触数据库；取消与最终提交由会话表串行决定。
                    let _ = SESSIONS.remove(&key_for_close);
                }
            });
            Ok::<_, crate::error::AppError>(())
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            _ => {
                let _ = SESSIONS.remove(&qr_key);
                return Err(SITE.error(
                    "window",
                    "无法打开抖音官方登录窗口，请重试或手动输入 Cookie",
                ));
            }
        }
        // 取消可能发生在原生建窗尚未返回时，不能把已撤销的句柄交给前端。
        SESSIONS.get(&qr_key)?;
        let expiry_key = qr_key.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(LOGIN_TTL).await;
            // 会话可能已被取消、关闭或登录成功而移除；`remove` 幂等，
            // 仅在仍持有时触发 Drop 在锁外销毁窗口并清理缓存。
            let _ = SESSIONS.remove(&expiry_key);
        });
        Ok(QrLoginStart {
            qr_code_url: String::new(),
            qr_key,
        })
    }

    pub async fn poll(qr_key: &str) -> AppResult<QrLoginPoll> {
        if !qr::is_valid_session_key(qr_key) {
            return Err(SITE.error("invalid_key", "登录会话无效，请重新打开登录窗口"));
        }
        let session = match SESSIONS.get(qr_key) {
            Ok(session) => session,
            Err(error) if error.code == "douyin_qr_expired" => return Ok(QrLoginPoll::Expired),
            Err(error) => return Err(error),
        };
        let Some(window) = session.app.get_webview_window(&session.label) else {
            SESSIONS.remove(qr_key)?;
            return Ok(QrLoginPoll::Expired);
        };
        let cookies = tauri::async_runtime::spawn_blocking(move || {
            window.cookies_for_url(Url::parse(COOKIE_URL).expect("fixed cookie URL"))
        })
        .await
        .map_err(|_| SITE.error("cookie_read", "读取登录窗口状态失败，请稍后重试"))?
        .map_err(|_| SITE.error("cookie_read", "读取登录窗口状态失败，请稍后重试"))?;
        let Some(cookie) =
            login_cookie(cookies.iter().map(|cookie| (cookie.name(), cookie.value())))
        else {
            return Ok(QrLoginPoll::Pending);
        };
        match douyin_profile::lookup(&cookie, session.proxy.as_deref()).await {
            douyin_profile::ProfileLookup::Valid(_) => {
                // 网络验证期间关闭/刷新过窗口，就不能提交这次迟到结果。
                if SESSIONS.get(qr_key).is_err() {
                    return Ok(QrLoginPoll::Expired);
                }
                Ok(QrLoginPoll::Success { cookie })
            }
            douyin_profile::ProfileLookup::Rejected => Ok(QrLoginPoll::Pending),
            douyin_profile::ProfileLookup::Unavailable => Err(SITE.retryable_error(
                "verification",
                "已读取到网页会话，但暂时无法确认登录状态；请保持窗口打开，稍后自动重试",
            )),
        }
    }

    pub fn cancel(qr_key: &str) -> AppResult<()> {
        if !qr::is_valid_session_key(qr_key) {
            return Err(SITE.error("invalid_key", "登录会话无效"));
        }
        // 从会话表移除后 `Arc` 归零，Drop 在锁外异步销毁窗口并清理缓存。
        // 已过期/已提交的会话视为已取消，不向前端报错（取消必须幂等）。
        match SESSIONS.take(qr_key) {
            Ok(_) => Ok(()),
            Err(error) if error.code == "douyin_qr_expired" => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn cancel_all() -> AppResult<()> {
        // `drain` 在锁内取走全部载荷，Drop 在锁外执行。
        drop(SESSIONS.drain()?);
        Ok(())
    }

    /// 调用方已持有数据库锁；取消/窗口关闭/过期与实际落库共用会话锁。
    /// 保存失败时保留窗口和会话，以便下一次轮询重试。
    pub fn finish(qr_key: &str, save: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        SESSIONS.commit(qr_key, save)
    }

    fn is_allowed_navigation(url: &Url) -> bool {
        qr::is_trusted_url(url, &["douyin.com"])
    }

    fn browser_proxy(proxy: Option<&str>) -> AppResult<Option<Url>> {
        let Some(proxy) = proxy.map(str::trim).filter(|proxy| !proxy.is_empty()) else {
            return Ok(None);
        };
        let url = Url::parse(proxy).map_err(|_| SITE.error("proxy", "登录窗口代理地址无效"))?;
        if url.scheme() != "http"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(SITE.error(
                "proxy",
                "官方登录窗口仅支持无认证的 HTTP 代理；请调整应用代理或手动输入 Cookie",
            ));
        }
        Ok(Some(url))
    }

    fn login_cookie<'a>(pairs: impl Iterator<Item = (&'a str, &'a str)>) -> Option<String> {
        let pairs = pairs.collect::<Vec<_>>();
        let logged_in = pairs.iter().any(|(key, value)| {
            matches!(*key, "sessionid" | "sessionid_ss") && !value.trim().is_empty()
        });
        if !logged_in {
            return None;
        }
        // CookieStore 已按目标 URL 过滤域、路径与有效期；再检查头部安全边界。
        if pairs
            .iter()
            .any(|(key, value)| key.contains([';', '=']) || value.contains(';'))
        {
            return None;
        }
        let cookie = pairs
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        crate::account::cookie_header_value(&cookie).map(str::to_owned)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn login_cookie_requires_a_real_session_and_safe_header() {
            assert_eq!(login_cookie([("ttwid", "anonymous")].into_iter()), None);
            assert_eq!(login_cookie([("sessionid", "")].into_iter()), None);
            assert_eq!(
                login_cookie([("sessionid_ss", "new"), ("ttwid", "anon")].into_iter()),
                Some("sessionid_ss=new; ttwid=anon".into())
            );
            for pairs in [
                [("sessionid", "new\r\nInjected: value")],
                [("sessionid", "new; other=bad")],
            ] {
                assert_eq!(login_cookie(pairs.into_iter()), None);
            }
            assert_eq!(
                login_cookie([("sessionid", "x".repeat(16384).as_str())].into_iter()),
                None
            );
        }

        #[test]
        fn official_window_cannot_navigate_to_local_or_untrusted_pages() {
            assert!(is_allowed_navigation(&Url::parse(LOGIN_URL).unwrap()));
            assert!(is_allowed_navigation(
                &Url::parse("https://sso.douyin.com/login").unwrap()
            ));
            for url in [
                "http://live.douyin.com/",
                "https://douyin.com.evil.test/",
                "http://localhost:1420/settings",
                "tauri://localhost",
                "file:///etc/passwd",
                "https://user:password@douyin.com/",
                "https://douyin.com:8443/",
            ] {
                assert!(!is_allowed_navigation(&Url::parse(url).unwrap()), "{url}");
            }
        }

        #[test]
        fn unsupported_proxy_is_not_silently_ignored() {
            assert!(browser_proxy(None).unwrap().is_none());
            assert!(
                browser_proxy(Some("http://127.0.0.1:7890"))
                    .unwrap()
                    .is_some()
            );
            for proxy in [
                "https://127.0.0.1:7890",
                "http://user:secret@localhost:7890",
                "not a proxy",
            ] {
                assert!(browser_proxy(Some(proxy)).is_err());
            }
        }
    }
}
