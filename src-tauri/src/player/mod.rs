use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Formats headers for mpv `--http-header-fields` (comma-separated `Key: Value`).
pub fn format_mpv_headers(headers: &HashMap<String, String>) -> String {
    headers
        .iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// Screen-space bounds for embedding the mpv window over the player host.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PlayerBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
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
        // Named pipe style path for mpv on Windows.
        PathBuf::from(format!(r"\\.\pipe\rlive-mpv-{stamp}"))
    }
    #[cfg(not(windows))]
    {
        let dir = std::env::temp_dir();
        dir.join(format!("rlive-mpv-{stamp}.sock"))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerStatus {
    pub running: bool,
    pub mpv_path: String,
    pub paused: bool,
    pub volume: u8,
    pub embed: bool,
}

struct PlayerInner {
    child: Option<Child>,
    ipc: Option<PathBuf>,
    last_path: String,
    paused: bool,
    volume: u8,
    embed: bool,
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
                ipc: None,
                last_path: String::new(),
                paused: false,
                volume: 80,
                embed: true,
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
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
        bounds: Option<PlayerBounds>,
        embed: bool,
    ) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| {
            AppError::new("player_lock_error", "player mutex poisoned")
        })?;
        Self::stop_locked(&mut inner)?;

        let ipc = ipc_path();
        let mut cmd = Command::new(mpv_path);

        // Keep alive for live streams; IPC for control.
        cmd.arg("--keep-open=yes")
            .arg("--idle=yes")
            .arg("--force-window=yes")
            .arg("--osc=no")
            .arg("--input-default-bindings=yes")
            .arg(format!("--input-ipc-server={}", ipc.display()))
            .arg(format!("--volume={}", inner.volume))
            .arg(format!(
                "--title={}",
                title.unwrap_or("rLive").replace(['\n', '\r'], " ")
            ));

        if embed {
            cmd.arg("--no-border")
                .arg("--ontop=no")
                .arg("--cursor-autohide=always");
            if let Some(b) = bounds {
                if b.width > 0 && b.height > 0 {
                    cmd.arg(format!(
                        "--geometry={}x{}+{}+{}",
                        b.width, b.height, b.x, b.y
                    ));
                }
            }
        } else {
            cmd.arg("--force-window=yes");
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

        // Load URL after window is up; using direct arg is fine for live.
        cmd.arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd.spawn().map_err(|e| {
            AppError::new("mpv_spawn_error", format!("failed to start mpv: {e}")).retryable()
        })?;

        // Give IPC a moment to appear.
        std::thread::sleep(std::time::Duration::from_millis(150));

        inner.child = Some(child);
        inner.ipc = Some(ipc);
        inner.last_path = mpv_path.display().to_string();
        inner.paused = false;
        inner.embed = embed;
        inner.bounds = bounds;
        Ok(())
    }

    pub fn load(
        &self,
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
        bounds: Option<PlayerBounds>,
        embed: bool,
    ) -> AppResult<()> {
        // Prefer IPC replace if already running; else open.
        {
            let inner = self.inner.lock().map_err(|_| {
                AppError::new("player_lock_error", "player mutex poisoned")
            })?;
            if inner.child.is_some() && inner.ipc.is_some() {
                let ipc = inner.ipc.clone().unwrap();
                drop(inner);
                // loadfile replace
                let _ = Self::ipc_command_path(
                    &ipc,
                    serde_json::json!(["loadfile", url, "replace"]),
                );
                if let Some(b) = bounds {
                    let _ = self.set_bounds(b);
                }
                return Ok(());
            }
        }
        self.open(mpv_path, url, headers, title, bounds, embed)
    }

    pub fn stop(&self) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| {
            AppError::new("player_lock_error", "player mutex poisoned")
        })?;
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
            // Graceful then force.
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
        inner.paused = false;
        Ok(())
    }

    pub fn set_pause(&self, paused: bool) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| {
            AppError::new("player_lock_error", "player mutex poisoned")
        })?;
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
        let mut inner = self.inner.lock().map_err(|_| {
            AppError::new("player_lock_error", "player mutex poisoned")
        })?;
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

    /// Show a short OSD text on the video (works over embedded window).
    pub fn show_osd_text(&self, text: &str, duration_ms: u64) -> AppResult<()> {
        let inner = self.inner.lock().map_err(|_| {
            AppError::new("player_lock_error", "player mutex poisoned")
        })?;
        if inner.child.is_none() {
            return Ok(()); // silent if not playing
        }
        let ipc = match &inner.ipc {
            Some(p) => p.clone(),
            None => return Ok(()),
        };
        // mpv show-text: text, duration(ms)
        let safe: String = text.chars().take(80).collect();
        let _ = Self::ipc_command_path(
            &ipc,
            serde_json::json!(["show-text", safe, duration_ms.max(500)]),
        );
        Ok(())
    }

    pub fn set_bounds(&self, bounds: PlayerBounds) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| {
            AppError::new("player_lock_error", "player mutex poisoned")
        })?;
        inner.bounds = Some(bounds);
        if !inner.embed {
            return Ok(());
        }
        if bounds.width == 0 || bounds.height == 0 {
            return Ok(());
        }
        if inner.child.is_none() {
            return Ok(());
        }
        let ipc = match &inner.ipc {
            Some(p) => p.clone(),
            None => return Ok(()),
        };
        // geometry as WxH+X+Y
        let geo = format!(
            "{}x{}{:+}{:+}",
            bounds.width, bounds.height, bounds.x, bounds.y
        );
        let _ = Self::ipc_command_path(
            &ipc,
            serde_json::json!(["set_property", "geometry", geo]),
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
                    embed: true,
                };
            }
        };

        let running = if let Some(child) = inner.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    inner.child = None;
                    inner.ipc = None;
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
            embed: inner.embed,
        }
    }

    fn ensure_running(inner: &mut PlayerInner) -> AppResult<()> {
        if let Some(child) = inner.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    inner.child = None;
                    inner.ipc = None;
                }
                _ => {}
            }
        }
        if inner.child.is_none() {
            return Err(AppError::new("player_not_running", "mpv is not running"));
        }
        Ok(())
    }

    /// Send a JSON IPC command array, e.g. `["set_property","pause",true]`.
    fn ipc_command_path(ipc: &Path, command: serde_json::Value) -> AppResult<()> {
        let payload = serde_json::json!({ "command": command });
        let line = format!("{payload}\n");
        Self::write_ipc(ipc, line.as_bytes())
    }

    fn write_ipc(ipc: &Path, bytes: &[u8]) -> AppResult<()> {
        #[cfg(windows)]
        {
            use std::fs::OpenOptions;
            // Named pipes: open with write
            let mut f = OpenOptions::new()
                .write(true)
                .open(ipc)
                .map_err(|e| {
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
        h.insert("User-Agent".into(), "test-ua".into());
        let s = format_mpv_headers(&h);
        assert!(s.contains("Referer: https://live.bilibili.com/"));
        assert!(s.contains("User-Agent: test-ua"));
    }

    #[test]
    fn resolve_missing_mpv_errors() {
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

    #[test]
    fn resolve_prefers_system_mpv_when_present() {
        if !Path::new("/usr/bin/mpv").is_file() {
            return;
        }
        let p = resolve_mpv_path(None).expect("mpv should resolve");
        assert_eq!(p, PathBuf::from("/usr/bin/mpv"));
    }

    #[test]
    fn bounds_serde() {
        let b = PlayerBounds {
            x: 10,
            y: 20,
            width: 800,
            height: 450,
        };
        let v = serde_json::to_string(&b).unwrap();
        assert!(v.contains("800"));
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
        mgr.open(
            &mpv,
            "av://lavfi:testsrc=duration=10:size=320x240:rate=30",
            &headers,
            Some("rlive-smoke"),
            Some(PlayerBounds {
                x: 100,
                y: 100,
                width: 320,
                height: 240,
            }),
            true,
        )
        .expect("open");
        thread::sleep(Duration::from_millis(500));
        let st = mgr.status(None);
        assert!(st.running, "mpv should be running");
        let _ = mgr.set_volume(50);
        let _ = mgr.set_pause(true);
        thread::sleep(Duration::from_millis(200));
        mgr.stop().expect("stop");
        thread::sleep(Duration::from_millis(200));
        let st2 = mgr.status(None);
        assert!(!st2.running, "mpv should be stopped");
    }
}
