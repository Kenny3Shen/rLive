mod embed_host;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

use crate::error::{AppError, AppResult};
use crate::player::embed_host::EmbedHost;

/// Formats headers for mpv `--http-header-fields` (comma-separated `Key: Value`).
pub fn format_mpv_headers(headers: &HashMap<String, String>) -> String {
    headers
        .iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// Client-relative bounds (physical px) for the player host inside the main window.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PlayerBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedMode {
    /// Native child window + mpv `--wid` (Windows).
    Child,
    /// Borderless mpv window positioned with geometry.
    Geometry,
    /// Separate decorated mpv window.
    Window,
}

impl Default for EmbedMode {
    fn default() -> Self {
        EmbedMode::Child
    }
}

/// UI presentation mode: HWND/geometry embed vs independent fullscreen mpv window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlayerMode {
    #[default]
    Windowed,
    Fullscreen,
}

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
    which_mpv().ok_or_else(|| {
        AppError::new(
            "mpv_not_found",
            "mpv not found: install mpv or set Settings → mpv path",
        )
        .retryable()
    })
}

fn which_mpv() -> Option<PathBuf> {
    let mut candidates: Vec<String> = vec![
        "/usr/bin/mpv".into(),
        "/usr/local/bin/mpv".into(),
        "/opt/homebrew/bin/mpv".into(),
        "/bin/mpv".into(),
        r"C:\Program Files\MPV Player\mpv.exe".into(),
        r"C:\Program Files\mpv\mpv.exe".into(),
        r"C:\Program Files (x86)\mpv\mpv.exe".into(),
        r"C:\Program Files (x86)\MPV Player\mpv.exe".into(),
        r"D:\dev\tools\mpv\mpv.exe".into(),
        r"D:\mpv\mpv.exe".into(),
        r"C:\mpv\mpv.exe".into(),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/mpv").display().to_string());
        candidates.push(
            home.join(r"scoop\apps\mpv\current\mpv.exe")
                .display()
                .to_string(),
        );
        candidates.push(
            home.join(r"AppData\Local\Microsoft\WinGet\Links\mpv.exe")
                .display()
                .to_string(),
        );
        if let Ok(entries) =
            std::fs::read_dir(home.join(r"AppData\Local\Microsoft\WinGet\Packages"))
        {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.contains("mpv") {
                    let exe = entry.path().join("mpv.exe");
                    if exe.is_file() {
                        candidates.push(exe.display().to_string());
                    }
                    if let Ok(sub) = std::fs::read_dir(entry.path()) {
                        for s in sub.flatten() {
                            let p = s.path().join("mpv.exe");
                            if p.is_file() {
                                candidates.push(p.display().to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    for candidate in &candidates {
        let p = Path::new(candidate);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }

    #[cfg(windows)]
    let finder = "where";
    #[cfg(not(windows))]
    let finder = "which";

    for name in ["mpv", "mpv.exe"] {
        if let Ok(output) = Command::new(finder).arg(name).output() {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let s = line.trim();
                    if s.is_empty() {
                        continue;
                    }
                    let p = PathBuf::from(s);
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

fn ipc_path() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    #[cfg(windows)]
    {
        PathBuf::from(format!(r"\\.\pipe\rlive-mpv-{stamp}"))
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir().join(format!("rlive-mpv-{stamp}.sock"))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerStatus {
    pub running: bool,
    pub mpv_path: String,
    pub paused: bool,
    pub volume: u8,
    pub embed_mode: EmbedMode,
    pub mode: PlayerMode,
}

struct PlayerInner {
    child: Option<Child>,
    host: Option<EmbedHost>,
    ipc: Option<PathBuf>,
    last_path: String,
    paused: bool,
    volume: u8,
    embed_mode: EmbedMode,
    mode: PlayerMode,
    bounds: Option<PlayerBounds>,
}

pub struct PlayerManager {
    inner: Mutex<PlayerInner>,
}

impl Default for PlayerManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(PlayerInner {
                child: None,
                host: None,
                ipc: None,
                last_path: String::new(),
                paused: false,
                volume: 80,
                embed_mode: EmbedMode::Child,
                mode: PlayerMode::Windowed,
                bounds: None,
            }),
        }
    }
}

impl PlayerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(
        &self,
        window: Option<&WebviewWindow>,
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
        bounds: Option<PlayerBounds>,
        prefer_child: bool,
    ) -> AppResult<()> {
        let mut inner = self.lock()?;
        Self::stop_locked(&mut inner)?;

        let mut mode = if prefer_child {
            EmbedMode::Child
        } else {
            EmbedMode::Geometry
        };

        // Try native child host (Windows).
        let mut host = None;
        if mode == EmbedMode::Child {
            if let (Some(win), Some(b)) = (window, bounds) {
                match EmbedHost::create(win, b) {
                    Ok(h) => host = Some(h),
                    Err(e) => {
                        tracing::warn!("child embed failed, geometry fallback: {}", e);
                        mode = EmbedMode::Geometry;
                    }
                }
            } else {
                mode = EmbedMode::Geometry;
            }
        }

        let ipc = ipc_path();
        let mut cmd = Command::new(mpv_path);
        cmd.arg("--keep-open=yes")
            .arg("--idle=yes")
            .arg("--osc=no")
            .arg("--input-default-bindings=yes")
            .arg(format!("--input-ipc-server={}", ipc.display()))
            .arg(format!("--volume={}", inner.volume))
            .arg(format!(
                "--title={}",
                title.unwrap_or("rLive").replace(['\n', '\r'], " ")
            ));

        match mode {
            EmbedMode::Child => {
                if let Some(ref h) = host {
                    cmd.arg(format!("--wid={}", h.wid_arg()));
                    // vo=gpu often works better with wid
                    cmd.arg("--vo=gpu");
                }
            }
            EmbedMode::Geometry => {
                cmd.arg("--force-window=yes")
                    .arg("--no-border")
                    .arg("--ontop=no")
                    .arg("--cursor-autohide=always");
                if let Some(b) = bounds {
                    if b.width > 0 && b.height > 0 {
                        // Geometry fallback uses absolute coords from frontend when provided
                        // as client-relative; still useful if OS places relative to work area.
                        cmd.arg(format!(
                            "--geometry={}x{}+{}+{}",
                            b.width, b.height, b.x, b.y
                        ));
                    }
                }
            }
            EmbedMode::Window => {
                cmd.arg("--force-window=yes");
            }
        }

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
            // Clean host if spawn fails.
            drop(host.take());
            AppError::new("mpv_spawn_error", format!("failed to start mpv: {e}")).retryable()
        })?;

        std::thread::sleep(std::time::Duration::from_millis(120));

        inner.child = Some(child);
        inner.host = host;
        inner.ipc = Some(ipc);
        inner.last_path = mpv_path.display().to_string();
        inner.paused = false;
        inner.embed_mode = mode;
        inner.bounds = bounds;
        Ok(())
    }

    /// Replace the current stream. Always stop + open so HTTP headers
    /// (`--http-header-fields`, Referer, etc.) are re-applied. mpv
    /// `loadfile replace` does not re-apply process-level header flags.
    pub fn load(
        &self,
        window: Option<&WebviewWindow>,
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
        bounds: Option<PlayerBounds>,
        prefer_child: bool,
    ) -> AppResult<()> {
        // open() already stop_locked; keep same prefer_child/bounds/mode path.
        self.open(
            window,
            mpv_path,
            url,
            headers,
            title,
            bounds,
            prefer_child,
        )
    }

    /// Leave embed and open mpv as a true fullscreen OS window (no `--wid`).
    /// Canvas/overlay is Task 4 — video only here.
    pub fn enter_fullscreen(
        &self,
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
    ) -> AppResult<()> {
        let mut inner = self.lock()?;

        // Already fullscreen and still running → no-op.
        if inner.mode == PlayerMode::Fullscreen {
            if let Some(child) = inner.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        inner.child = None;
                        inner.ipc = None;
                        inner.host = None;
                    }
                    Ok(None) | Err(_) => return Ok(()),
                }
            }
        }

        Self::stop_locked(&mut inner)?;

        let ipc = ipc_path();
        let mut cmd = Command::new(mpv_path);
        cmd.arg("--keep-open=yes")
            .arg("--idle=yes")
            .arg("--osc=no")
            .arg("--input-default-bindings=yes")
            .arg(format!("--input-ipc-server={}", ipc.display()))
            .arg(format!("--volume={}", inner.volume))
            .arg(format!(
                "--title={}",
                title.unwrap_or("rLive").replace(['\n', '\r'], " ")
            ))
            // No --wid: independent window, force FS.
            .arg("--force-window=yes")
            .arg("--fullscreen=yes");

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
            AppError::new("mpv_spawn_error", format!("failed to start mpv fullscreen: {e}"))
                .retryable()
        })?;

        std::thread::sleep(std::time::Duration::from_millis(120));

        inner.child = Some(child);
        inner.host = None;
        inner.ipc = Some(ipc);
        inner.last_path = mpv_path.display().to_string();
        inner.paused = false;
        inner.embed_mode = EmbedMode::Window;
        inner.mode = PlayerMode::Fullscreen;
        Ok(())
    }

    /// Stop fullscreen mpv and re-open embedded (prefer_child + bounds).
    pub fn exit_fullscreen(
        &self,
        window: Option<&WebviewWindow>,
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
        bounds: Option<PlayerBounds>,
    ) -> AppResult<()> {
        // open() stop_locked first, then restores HWND/geometry embed.
        self.open(
            window,
            mpv_path,
            url,
            headers,
            title,
            bounds,
            true,
        )?;
        let mut inner = self.lock()?;
        inner.mode = PlayerMode::Windowed;
        Ok(())
    }

    pub fn stop(&self) -> AppResult<()> {
        let mut inner = self.lock()?;
        Self::stop_locked(&mut inner)
    }

    fn stop_locked(inner: &mut PlayerInner) -> AppResult<()> {
        if let Some(ipc) = inner.ipc.take() {
            let _ = Self::ipc_command_path(&ipc, serde_json::json!(["quit"]));
            #[cfg(not(windows))]
            {
                let _ = std::fs::remove_file(&ipc);
            }
        }
        if let Some(mut child) = inner.child.take() {
            std::thread::sleep(std::time::Duration::from_millis(80));
            match child.try_wait() {
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                _ => {
                    let _ = child.wait();
                }
            }
        }
        // Destroy host after mpv exits so --wid is released cleanly.
        inner.host = None;
        inner.paused = false;
        Ok(())
    }

    pub fn set_pause(&self, paused: bool) -> AppResult<()> {
        let mut inner = self.lock()?;
        Self::ensure_running(&mut inner)?;
        let ipc = inner.ipc.clone().ok_or_else(|| {
            AppError::new("player_ipc_missing", "mpv ipc not available")
        })?;
        Self::ipc_command_path(&ipc, serde_json::json!(["set_property", "pause", paused]))?;
        inner.paused = paused;
        Ok(())
    }

    pub fn set_volume(&self, volume: u8) -> AppResult<()> {
        let volume = volume.min(100);
        let mut inner = self.lock()?;
        Self::ensure_running(&mut inner)?;
        let ipc = inner.ipc.clone().ok_or_else(|| {
            AppError::new("player_ipc_missing", "mpv ipc not available")
        })?;
        Self::ipc_command_path(
            &ipc,
            serde_json::json!(["set_property", "volume", volume]),
        )?;
        inner.volume = volume;
        Ok(())
    }

    pub fn set_bounds(&self, bounds: PlayerBounds) -> AppResult<()> {
        let mut inner = self.lock()?;
        inner.bounds = Some(bounds);
        if bounds.width == 0 || bounds.height == 0 {
            return Ok(());
        }
        if let Some(host) = inner.host.as_ref() {
            host.set_bounds(bounds)?;
            return Ok(());
        }
        // Geometry mode
        if inner.embed_mode == EmbedMode::Geometry {
            if let Some(ipc) = inner.ipc.clone() {
                let geo = format!(
                    "{}x{}{:+}{:+}",
                    bounds.width, bounds.height, bounds.x, bounds.y
                );
                let _ = Self::ipc_command_path(
                    &ipc,
                    serde_json::json!(["set_property", "geometry", geo]),
                );
            }
        }
        Ok(())
    }

    pub fn show_osd_text(&self, text: &str, duration_ms: u64) -> AppResult<()> {
        let inner = self.lock()?;
        if inner.child.is_none() {
            return Ok(());
        }
        let ipc = match &inner.ipc {
            Some(p) => p.clone(),
            None => return Ok(()),
        };
        let safe: String = text.chars().take(80).collect();
        let _ = Self::ipc_command_path(
            &ipc,
            serde_json::json!(["show-text", safe, duration_ms.max(500)]),
        );
        Ok(())
    }

    pub fn status(&self, settings_path: Option<&str>) -> PlayerStatus {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => {
                return PlayerStatus {
                    running: false,
                    mpv_path: String::new(),
                    paused: false,
                    volume: 0,
                    embed_mode: EmbedMode::Child,
                    mode: PlayerMode::Windowed,
                };
            }
        };

        let running = if let Some(child) = inner.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    inner.child = None;
                    inner.ipc = None;
                    inner.host = None;
                    false
                }
                Ok(None) => true,
                Err(_) => true,
            }
        } else {
            false
        };

        let mpv_path = resolve_mpv_path(settings_path)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| inner.last_path.clone());

        PlayerStatus {
            running,
            mpv_path,
            paused: inner.paused,
            volume: inner.volume,
            embed_mode: inner.embed_mode,
            mode: inner.mode,
        }
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, PlayerInner>> {
        self.inner
            .lock()
            .map_err(|_| AppError::new("player_lock_error", "player mutex poisoned"))
    }

    fn ensure_running(inner: &mut PlayerInner) -> AppResult<()> {
        if let Some(child) = inner.child.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                inner.child = None;
                inner.ipc = None;
                inner.host = None;
            }
        }
        if inner.child.is_none() {
            return Err(AppError::new("player_not_running", "mpv is not running"));
        }
        Ok(())
    }

    fn ipc_command_path(ipc: &Path, command: serde_json::Value) -> AppResult<()> {
        let payload = serde_json::json!({ "command": command });
        let line = format!("{payload}\n");
        Self::write_ipc(ipc, line.as_bytes())
    }

    fn write_ipc(ipc: &Path, bytes: &[u8]) -> AppResult<()> {
        #[cfg(windows)]
        {
            use std::fs::OpenOptions;
            let mut f = OpenOptions::new().write(true).open(ipc).map_err(|e| {
                AppError::new(
                    "player_ipc_error",
                    format!("open ipc {}: {e}", ipc.display()),
                )
                .retryable()
            })?;
            f.write_all(bytes).map_err(|e| {
                AppError::new("player_ipc_error", format!("write ipc: {e}")).retryable()
            })?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::net::UnixStream;
            let mut stream = UnixStream::connect(ipc).map_err(|e| {
                AppError::new(
                    "player_ipc_error",
                    format!("connect ipc {}: {e}", ipc.display()),
                )
                .retryable()
            })?;
            stream.write_all(bytes).map_err(|e| {
                AppError::new("player_ipc_error", format!("write ipc: {e}")).retryable()
            })?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_http_headers() {
        let mut h = HashMap::new();
        h.insert("Referer".into(), "https://live.bilibili.com/".into());
        let s = format_mpv_headers(&h);
        assert!(s.contains("Referer: https://live.bilibili.com/"));
    }

    #[test]
    fn resolve_invalid_configured_path() {
        let err = resolve_mpv_path(Some("/definitely/not/a/real/mpv-binary-xyz")).unwrap_err();
        assert_eq!(err.code, "mpv_not_found");
    }

    #[test]
    fn bounds_serde() {
        let b = PlayerBounds {
            x: 10,
            y: 20,
            width: 800,
            height: 450,
        };
        let v = serde_json::to_value(b).unwrap();
        assert_eq!(v["width"], 800);
    }

    #[test]
    fn player_mode_serde_snake_case() {
        assert_eq!(
            serde_json::to_value(PlayerMode::Windowed).unwrap(),
            serde_json::json!("windowed")
        );
        assert_eq!(
            serde_json::to_value(PlayerMode::Fullscreen).unwrap(),
            serde_json::json!("fullscreen")
        );
        let m: PlayerMode = serde_json::from_str("\"windowed\"").unwrap();
        assert_eq!(m, PlayerMode::Windowed);
    }

    #[test]
    fn player_status_includes_mode() {
        let mgr = PlayerManager::default();
        let st = mgr.status(None);
        assert_eq!(st.mode, PlayerMode::Windowed);
        assert!(!st.running);
        let v = serde_json::to_value(&st).unwrap();
        assert_eq!(v["mode"], "windowed");
    }
}
