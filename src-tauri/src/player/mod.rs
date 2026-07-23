use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Formats headers for mpv `--http-header-fields` (comma-separated `Key: Value`).
pub fn format_mpv_headers(headers: &HashMap<String, String>) -> String {
    headers
        .iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// Resolve mpv binary: settings path → PATH lookup.
pub fn resolve_mpv_path(settings_path: Option<&str>) -> AppResult<PathBuf> {
    if let Some(p) = settings_path {
        let p = p.trim();
        if !p.is_empty() {
            let path = PathBuf::from(p);
            if path.is_file() {
                return Ok(path);
            }
            return Err(AppError::new(
                "mpv_not_found",
                format!("configured mpv_path is not a file: {p}"),
            )
            .retryable());
        }
    }

    if let Some(path) = which_mpv() {
        return Ok(path);
    }

    Err(AppError::new(
        "mpv_not_found",
        "mpv not found: install mpv or set Settings → mpv path",
    )
    .retryable())
}

fn which_mpv() -> Option<PathBuf> {
    // Prefer `which` on Unix; also try common names.
    for name in ["mpv", "mpv.exe"] {
        if let Ok(output) = Command::new("which").arg(name).output() {
            if output.status.success() {
                let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !s.is_empty() {
                    let p = PathBuf::from(&s);
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }
    // Fallback: check common absolute locations + user-local install.
    let mut candidates = vec![
        "/usr/bin/mpv".to_string(),
        "/usr/local/bin/mpv".to_string(),
        "/opt/homebrew/bin/mpv".to_string(),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/mpv").display().to_string());
    }
    for candidate in candidates {
        let p = Path::new(&candidate);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerStatus {
    pub running: bool,
    pub mpv_path: String,
}

pub struct PlayerManager {
    child: Mutex<Option<Child>>,
    last_path: Mutex<String>,
}

impl Default for PlayerManager {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            last_path: Mutex::new(String::new()),
        }
    }
}

impl PlayerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(
        &self,
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
    ) -> AppResult<()> {
        self.stop_inner()?;

        let mut cmd = Command::new(mpv_path);
        cmd.arg("--force-window=yes")
            .arg("--keep-open=yes")
            .arg("--idle=no")
            .arg(format!(
                "--title={}",
                title.unwrap_or("rLive").replace('\n', " ")
            ));

        if let Some(ua) = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("user-agent"))
            .map(|(_, v)| v.clone())
        {
            cmd.arg(format!("--user-agent={ua}"));
        }

        let header_fields = format_mpv_headers(headers);
        if !header_fields.is_empty() {
            cmd.arg(format!("--http-header-fields={header_fields}"));
        }

        cmd.arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd.spawn().map_err(|e| {
            AppError::new("mpv_spawn_error", format!("failed to start mpv: {e}")).retryable()
        })?;

        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }
        if let Ok(mut path) = self.last_path.lock() {
            *path = mpv_path.display().to_string();
        }
        Ok(())
    }

    pub fn load(
        &self,
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
    ) -> AppResult<()> {
        // Phase 1: restart process on load (IPC optional later).
        self.open(mpv_path, url, headers, title)
    }

    pub fn stop(&self) -> AppResult<()> {
        self.stop_inner()
    }

    fn stop_inner(&self) -> AppResult<()> {
        let mut guard = self.child.lock().map_err(|_| {
            AppError::new("player_lock_error", "player mutex poisoned")
        })?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn set_pause(&self, paused: bool) -> AppResult<()> {
        // Without IPC, pause is best-effort no-op if process running.
        // Keep API surface for Task 9; real IPC can land later.
        let _ = paused;
        let running = self
            .child
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        if !running {
            return Err(AppError::new("player_not_running", "mpv is not running"));
        }
        Ok(())
    }

    pub fn set_volume(&self, volume: u8) -> AppResult<()> {
        let _ = volume.min(100);
        let running = self
            .child
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        if !running {
            return Err(AppError::new("player_not_running", "mpv is not running"));
        }
        Ok(())
    }

    pub fn status(&self, settings_path: Option<&str>) -> PlayerStatus {
        let running = self
            .child
            .lock()
            .map(|mut g| {
                if let Some(child) = g.as_mut() {
                    match child.try_wait() {
                        Ok(Some(_)) => {
                            *g = None;
                            false
                        }
                        Ok(None) => true,
                        Err(_) => true,
                    }
                } else {
                    false
                }
            })
            .unwrap_or(false);

        let mpv_path = resolve_mpv_path(settings_path)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| {
                self.last_path
                    .lock()
                    .map(|p| p.clone())
                    .unwrap_or_default()
            });

        PlayerStatus { running, mpv_path }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_http_headers() {
        let mut h = HashMap::new();
        h.insert("Referer".into(), "https://live.bilibili.com/".into());
        h.insert("User-Agent".into(), "test-ua".into());
        let s = format_mpv_headers(&h);
        assert!(s.contains("Referer: https://live.bilibili.com/"));
        assert!(s.contains("User-Agent: test-ua"));
    }

    #[test]
    fn resolve_missing_mpv_errors() {
        // Force miss: empty settings and assume which won't find fake path-only check.
        // If system has mpv this may pass with Ok — only assert Err when which_mpv is None.
        if which_mpv().is_none() {
            let err = resolve_mpv_path(None).unwrap_err();
            assert_eq!(err.code, "mpv_not_found");
        }
    }

    #[test]
    fn resolve_invalid_configured_path() {
        let err = resolve_mpv_path(Some("/definitely/not/a/real/mpv-binary-xyz")).unwrap_err();
        assert_eq!(err.code, "mpv_not_found");
    }
}

#[cfg(test)]
mod smoke_integration {
    use super::*;
    use std::collections::HashMap;
    use std::thread;
    use std::time::Duration;

    #[test]
    #[ignore = "requires mpv on PATH"]
    fn player_manager_open_stop_smoke() {
        let mpv = resolve_mpv_path(None).expect("mpv");
        let mgr = PlayerManager::new();
        let mut headers = HashMap::new();
        headers.insert("User-Agent".into(), "rlive-smoke".into());
        // short generated video
        mgr.open(
            &mpv,
            "av://lavfi:testsrc=duration=10:size=320x240:rate=30",
            &headers,
            Some("rlive-smoke"),
        )
        .expect("open");
        thread::sleep(Duration::from_millis(800));
        let st = mgr.status(None);
        assert!(st.running, "mpv should be running");
        mgr.stop().expect("stop");
        thread::sleep(Duration::from_millis(200));
        let st2 = mgr.status(None);
        assert!(!st2.running, "mpv should be stopped");
    }
}
