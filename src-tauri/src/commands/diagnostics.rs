//! Read-only access to the local app log for the About settings pane.
//!
//! Release Windows builds have no console, so `rlive.log` is the only record of
//! a failure a user can report. These commands let the About pane show the tail
//! of that log and reveal its folder, without the frontend needing filesystem
//! permissions of its own.
//!
//! The log is failure-only by construction (see `init_logging`): Cookie values,
//! tokens, and outgoing chat text are never written to it, so surfacing it in
//! the UI does not expose credentials.

use std::fs;
use std::io::{Read, Seek, SeekFrom};

use serde::Serialize;

use crate::app_paths::AppDirectories;
use crate::error::{AppError, AppResult};

/// Bytes read from the end of a log file. The log itself rotates at 2 MiB, but
/// a webview should not receive that much text at once: recent warnings are
/// what a report needs, and the folder is one click away for the full file.
const TAIL_BYTES: u64 = 256 * 1024;

/// One log file's tail plus the metadata the pane displays.
#[derive(Debug, Serialize)]
pub struct LogFileContent {
    /// Absolute path, shown so a user can find the file after closing the app.
    pub path: String,
    /// Whether the file exists yet. A clean install has no log at all.
    pub exists: bool,
    /// Full size on disk, so the pane can say the view is partial.
    pub size_bytes: u64,
    /// True when `size_bytes` exceeded the tail window and text was clipped.
    pub truncated: bool,
    /// The tail itself, oldest line first.
    pub text: String,
}

/// The app log directory and the tails of its current and rotated files.
#[derive(Debug, Serialize)]
pub struct AppLogSnapshot {
    /// Directory holding both files, for "open folder".
    pub directory: String,
    pub current: LogFileContent,
    /// The file `init_logging` rotates to once the current one passes its cap.
    pub previous: LogFileContent,
}

/// Read the last `TAIL_BYTES` of one log file.
///
/// A missing file is a normal state, not an error: nothing has gone wrong yet.
/// Seeking rather than reading the whole file keeps a rotated 2 MiB log cheap.
fn read_tail(path: &std::path::Path) -> LogFileContent {
    let display = path.display().to_string();
    let Ok(metadata) = path.metadata() else {
        return LogFileContent {
            path: display,
            exists: false,
            size_bytes: 0,
            truncated: false,
            text: String::new(),
        };
    };
    let size = metadata.len();
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) => {
            return LogFileContent {
                path: display,
                exists: true,
                size_bytes: size,
                truncated: false,
                text: format!("无法读取日志文件：{error}"),
            };
        }
    };
    let truncated = size > TAIL_BYTES;
    if truncated {
        // Ignore a seek failure: reading from the start is still useful.
        let _ = file.seek(SeekFrom::Start(size - TAIL_BYTES));
    }
    let mut buffer = Vec::new();
    if let Err(error) = file.read_to_end(&mut buffer) {
        return LogFileContent {
            path: display,
            exists: true,
            size_bytes: size,
            truncated,
            text: format!("无法读取日志文件：{error}"),
        };
    }
    // The tail can begin mid-line, and a multi-byte character can straddle the
    // seek offset, so decode lossily and drop the first partial line.
    let mut text = String::from_utf8_lossy(&buffer).into_owned();
    if truncated {
        if let Some(newline) = text.find('\n') {
            text = text[newline + 1..].to_owned();
        }
    }
    LogFileContent {
        path: display,
        exists: true,
        size_bytes: size,
        truncated,
        text,
    }
}

/// Current and rotated app log tails, for the About pane's log viewer.
#[tauri::command(async)]
pub async fn app_log_snapshot() -> AppResult<AppLogSnapshot> {
    let directories = AppDirectories::resolve(None)?;
    let logs = directories.logs;
    Ok(AppLogSnapshot {
        directory: logs.display().to_string(),
        current: read_tail(&logs.join("rlive.log")),
        previous: read_tail(&logs.join("rlive.previous.log")),
    })
}

/// Delete both log files.
///
/// Offered next to the viewer so a user can clear old noise before reproducing
/// an issue, which makes the resulting log far easier to read in a report. A
/// missing file counts as already cleared.
#[tauri::command(async)]
pub async fn app_log_clear() -> AppResult<()> {
    let logs = AppDirectories::resolve(None)?.logs;
    for name in ["rlive.log", "rlive.previous.log"] {
        match fs::remove_file(logs.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(AppError::new(
                    "app_log_clear_failed",
                    format!("删除日志文件 {name} 失败：{error}"),
                ));
            }
        }
    }
    Ok(())
}
