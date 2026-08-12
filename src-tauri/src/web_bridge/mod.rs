//! Loopback HTTP bridge that serves the existing React frontend to an ordinary
//! browser ("web platform").
//!
//! The desktop and mobile shells reach Rust through Tauri's `invoke` bridge and
//! its event system. A browser tab has neither, so this module exposes the same
//! capabilities over plain HTTP:
//!
//! - `GET /` and the built asset paths serve the Vite bundle from `frontendDist`
//! - `POST /api/invoke/<command>` dispatches to the *same* `#[tauri::command]`
//!   functions the WebView calls, so there is no parallel implementation of any
//!   site, database or playback logic
//! - `GET /api/events` streams the danmaku batches that the native path receives
//!   as Tauri events, re-encoded as Server-Sent Events
//!
//! Scope and safety. The listener binds loopback by default and is started only
//! when the user explicitly enables the web platform. It is not an
//! authentication boundary for the wider network: binding a LAN address means
//! anyone who can reach that port drives the same local database and accounts
//! as the desktop app, so that choice stays opt-in and carries a shared-secret
//! token. `stream_proxy` and `image_proxy` keep owning media and image traffic;
//! this bridge only carries command calls, events and static assets.

mod dispatch;
mod http;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU16, Ordering};

use tauri::AppHandle;
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::error::{AppError, AppResult};

/// Requests are small JSON command payloads; the bound keeps a hostile local
/// page from turning the listener into a memory sink.
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// The port the web platform prefers, so a bookmarked URL keeps working across
/// restarts. Falls back to an ephemeral port when it is taken.
const PREFERRED_PORT: u16 = 17650;

#[derive(Debug, Clone, serde::Serialize)]
pub struct WebBridgeInfo {
    /// Origin the user opens in a browser, e.g. `http://127.0.0.1:17650`.
    pub url: String,
    pub port: u16,
    /// True when bound to a LAN address rather than loopback only.
    pub lan_exposed: bool,
    /// Shared secret required by `/api/*` when `lan_exposed` is set.
    pub token: Option<String>,
}

pub struct WebBridge {
    state: Mutex<Option<WebBridgeInner>>,
    port: AtomicU16,
    info: Mutex<Option<WebBridgeInfo>>,
}

struct WebBridgeInner {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Default for WebBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl WebBridge {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(None),
            port: AtomicU16::new(0),
            info: Mutex::new(None),
        }
    }

    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(inner) = state.take() {
            let _ = inner.shutdown.send(true);
            inner.task.abort();
        }
        self.port.store(0, Ordering::Release);
        *self.info.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    pub fn status(&self) -> Option<WebBridgeInfo> {
        self.info
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Idempotent: returns the running bridge's info when already started.
    pub async fn start(&self, app: AppHandle, allow_lan: bool) -> AppResult<WebBridgeInfo> {
        if let Some(info) = self.status() {
            return Ok(info);
        }

        // A LAN-reachable bridge hands full local-app authority to any client
        // that can reach the port, so require a shared secret there. Loopback
        // is already limited to processes on this machine.
        let token = if allow_lan {
            Some(random_token())
        } else {
            None
        };
        let bind_ip = if allow_lan {
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        } else {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        };

        let listener = match TcpListener::bind(SocketAddr::new(bind_ip, PREFERRED_PORT)).await {
            Ok(listener) => listener,
            Err(_) => TcpListener::bind(SocketAddr::new(bind_ip, 0))
                .await
                .map_err(|error| {
                    AppError::new(
                        "web_bridge_bind_error",
                        format!("无法启动 Web 服务监听: {error}"),
                    )
                })?,
        };
        let port = listener
            .local_addr()
            .map_err(|error| {
                AppError::new(
                    "web_bridge_bind_error",
                    format!("无法读取 Web 服务端口: {error}"),
                )
            })?
            .port();

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let handle = app.clone();
        let auth = token.clone();
        let task = tauri::async_runtime::spawn(async move {
            http::serve(listener, handle, auth, shutdown_rx).await;
        });

        let info = WebBridgeInfo {
            url: format!("http://127.0.0.1:{port}"),
            port,
            lan_exposed: allow_lan,
            token,
        };
        *self.state.lock().unwrap_or_else(|p| p.into_inner()) = Some(WebBridgeInner {
            shutdown: shutdown_tx,
            task,
        });
        self.port.store(port, Ordering::Release);
        *self.info.lock().unwrap_or_else(|p| p.into_inner()) = Some(info.clone());
        Ok(info)
    }
}

fn random_token() -> String {
    // Two v4 UUIDs give 256 bits of entropy from the OS RNG, formatted as hex
    // so it survives a URL or a copy/paste without escaping.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_url_safe() {
        let first = random_token();
        let second = random_token();
        assert_ne!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn a_stopped_bridge_reports_no_status() {
        let bridge = WebBridge::new();
        assert!(bridge.status().is_none());
        bridge.stop();
        assert!(bridge.status().is_none());
    }
}
