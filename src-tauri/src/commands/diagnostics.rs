//! “关于”面板的原始日志查看与严格白名单诊断导出。
//!
//! 原始日志只供本机查看，不应视为已脱敏；可导出摘要必须通过
//! `diagnostics_summary` 的固定白名单，绝不直接序列化原始日志或路径。

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use crate::account;
use crate::diagnostics_summary::{
    AccountVerification, DiagnosticAccount, DiagnosticSnapshot, build_snapshot,
};
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::state::AppState;

/// 从日志文件末尾读取的字节数。日志本身在 2 MiB 时轮转，但 webview 不应
/// 一次收到那么多文本：反馈问题需要的是最近的警告，
/// 而完整文件只需一次点击即可在目录中打开。
const TAIL_BYTES: u64 = 256 * 1024;
const MAX_EXPORT_BYTES: usize = 128 * 1024;

fn validate_export_text(text: &str) -> AppResult<()> {
    if text.trim().is_empty() || text.len() > MAX_EXPORT_BYTES {
        return Err(AppError::new(
            "diagnostic_export_size",
            "摘要为空或超过 128 KiB 上限",
        ));
    }
    Ok(())
}

/// 只保存用户已经预览的文本，不重新采集；FilePath 同时支持桌面路径和 Android 文档 URI。
#[tauri::command(async)]
pub async fn app_diagnostic_export(
    app: tauri::AppHandle,
    path: FilePath,
    text: String,
) -> AppResult<()> {
    validate_export_text(&text)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut options = OpenOptions::new();
        options.write(true).truncate(true).create(true);
        let mut file = app
            .fs()
            .open(path, options)
            .map_err(|_| AppError::new("diagnostic_export_failed", "无法打开摘要保存位置"))?;
        file.write_all(text.as_bytes())
            .and_then(|()| file.flush())
            .map_err(|_| AppError::new("diagnostic_export_failed", "保存诊断摘要失败"))
    })
    .await
    .map_err(|_| AppError::new("diagnostic_export_failed", "保存诊断摘要失败"))?
}

/// 一个日志文件的尾部内容，以及面板要展示的元数据。
#[derive(Debug, Serialize)]
pub struct LogFileContent {
    /// 绝对路径，展示出来便于用户在关闭应用后找到该文件。
    pub path: String,
    /// 文件是否已存在。全新安装完全没有日志。
    pub exists: bool,
    /// 磁盘上的完整大小，便于面板说明当前视图是截断的。
    pub size_bytes: u64,
    /// 尾部窗口或读取异常导致内容不完整时为 true。
    pub truncated: bool,
    /// 尾部内容本身，最旧的一行在前。
    pub text: String,
    /// 首条残行的省略计数只供安全摘要使用，不改变原始日志 IPC 协议。
    #[serde(skip)]
    pub(crate) omitted_lines: usize,
}

/// 应用日志目录，以及当前文件与轮转文件的尾部内容。
#[derive(Debug, Serialize)]
pub struct AppLogSnapshot {
    /// 同时存放两个文件的目录，供"打开目录"使用。
    pub directory: String,
    pub current: LogFileContent,
    /// 当前文件超过上限后，`init_logging` 轮转到的那个文件。
    pub previous: LogFileContent,
}

/// 读取某个日志文件最后至多 `TAIL_BYTES` 字节。
/// 文件缺失是正常状态；其它读取异常一律标记信息不完整，不导出系统错误。
fn read_tail(path: &Path) -> LogFileContent {
    let mut result = LogFileContent {
        path: crate::app_paths::path_to_string(path),
        exists: true,
        size_bytes: 0,
        truncated: true,
        text: String::new(),
        omitted_lines: 0,
    };
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                result.exists = false;
                result.truncated = false;
            }
            return result;
        }
    };
    // 使用已打开句柄的 metadata，避免轮转发生于 path.metadata 与 open 之间。
    let Ok(metadata) = file.metadata() else {
        return result;
    };
    result.size_bytes = metadata.len();
    if !metadata.is_file() {
        return result;
    }
    if let Ok(window) = read_window(&mut file, metadata.len()) {
        result.text = window.text;
        result.truncated = window.truncated;
        result.omitted_lines = window.omitted_lines;
        // 读取期间追加、清空或轮转写入可能让快照不再覆盖完整文件。
        result.truncated |= file
            .metadata()
            .map_or(true, |now| now.len() != metadata.len());
    }
    result
}

struct TailWindow {
    text: String,
    truncated: bool,
    omitted_lines: usize,
}

fn read_window(reader: &mut (impl Read + Seek), size: u64) -> std::io::Result<TailWindow> {
    let offset = size.saturating_sub(TAIL_BYTES);
    // seek 失败立即返回，绝不能回退读取头部或标记为完整。
    reader.seek(SeekFrom::Start(offset))?;
    let limit = size.min(TAIL_BYTES);
    let mut buffer = Vec::new();
    // take 的计数上限冻结在 metadata 时刻，任何并发增长都无法令 read_to_end
    // 多读一个字节。即便文件被清空后重新增长，也不改变这一硬上限。
    reader.take(limit).read_to_end(&mut buffer)?;
    let truncated = offset > 0 || buffer.len() as u64 != limit;
    let mut omitted_lines = 0;
    if offset > 0 && !buffer.is_empty() {
        omitted_lines = 1;
        // 先按字节丢弃残行，再解码。没有换行意味着整个窗口都不可用。
        match buffer.iter().position(|byte| *byte == b'\n') {
            Some(newline) => {
                buffer.drain(..=newline);
            }
            None => buffer.clear(),
        }
    }
    Ok(TailWindow {
        text: String::from_utf8_lossy(&buffer).into_owned(),
        truncated,
        omitted_lines,
    })
}

fn snapshot_logs(logs: &Path) -> AppLogSnapshot {
    AppLogSnapshot {
        directory: crate::app_paths::path_to_string(logs),
        current: read_tail(&logs.join("rlive.log")),
        previous: read_tail(&logs.join("rlive.previous.log")),
    }
}

/// 当前与轮转的应用日志尾部内容，供“关于”面板的日志查看器使用。
///
/// 日志目录在启动时解析并保存在 `AppState` 中：Android 上移动宿主的
/// 数据目录仅在启动期间可得，事后无法重新解析。
#[tauri::command(async)]
pub async fn app_log_snapshot(state: State<'_, AppState>) -> AppResult<AppLogSnapshot> {
    let logs = state.directories.logs.clone();
    tauri::async_runtime::spawn_blocking(move || snapshot_logs(&logs))
        .await
        .map_err(|_| AppError::new("app_log_snapshot_failed", "读取日志快照失败"))
}

/// 只读取本机 Cookie 是否非空；失败表示未知，不进行网络验证。
fn snapshot_accounts(conn: Option<&Connection>) -> Vec<DiagnosticAccount> {
    [
        SiteId::Bilibili,
        SiteId::Huya,
        SiteId::Douyu,
        SiteId::Douyin,
        SiteId::Twitch,
    ]
    .into_iter()
    .map(|site_id| {
        let has_cookie = conn.and_then(|conn| {
            account::get_cookie(conn, &site_id)
                .ok()
                .map(|cookie| cookie.is_some_and(|value| !value.trim().is_empty()))
        });
        DiagnosticAccount {
            site_id,
            has_cookie,
            verification: AccountVerification::NotChecked,
        }
    })
    .collect()
}

/// 可供预览与导出的白名单摘要；文件与 SQLite 读取均在阻塞线程完成。
#[tauri::command(async)]
pub async fn app_diagnostic_snapshot(app: tauri::AppHandle) -> AppResult<DiagnosticSnapshot> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let logs = snapshot_logs(&state.directories.logs);
        let accounts = {
            let conn = state.conn().ok();
            snapshot_accounts(conn.as_deref())
        };
        build_snapshot(
            chrono::Utc::now().timestamp_millis(),
            &logs,
            state.stream_proxy.telemetry_totals(),
            accounts,
        )
    })
    .await
    .map_err(|_| AppError::new("app_diagnostic_snapshot_failed", "生成诊断摘要失败"))
}

/// 删除两个日志文件。
///
/// 它就放在查看器旁边，便于用户在复现问题前清掉旧的噪音，
/// 这会让最终日志在反馈中易读得多。
/// 文件不存在视为已清空。
#[tauri::command(async)]
pub async fn app_log_clear(state: State<'_, AppState>) -> AppResult<()> {
    let logs = state.directories.logs.clone();
    for name in ["rlive.log", "rlive.previous.log"] {
        match fs::remove_file(logs.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(AppError::new("app_log_clear_failed", "删除日志文件失败"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{TAIL_BYTES, read_tail, read_window, snapshot_accounts, snapshot_logs};
    use crate::diagnostics_summary::{build_snapshot, summarize_log};
    use crate::models::live::SiteId;
    use crate::stream_proxy::StreamProxy;
    use std::fs;
    use std::io::{self, Cursor, Read, Seek, SeekFrom};
    use std::path::PathBuf;

    use uuid::Uuid;

    fn temp_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("rlive-app-log-{label}-{}", Uuid::new_v4().simple()))
    }

    #[test]
    fn diagnostic_export_requires_nonempty_bounded_utf8() {
        assert!(super::validate_export_text("").is_err());
        assert!(super::validate_export_text(" \n\t").is_err());
        assert!(super::validate_export_text(&"x".repeat(super::MAX_EXPORT_BYTES)).is_ok());
        assert!(super::validate_export_text(&"x".repeat(super::MAX_EXPORT_BYTES + 1)).is_err());
        assert!(
            super::validate_export_text(&"中".repeat(super::MAX_EXPORT_BYTES / 3 + 1)).is_err()
        );
    }

    #[test]
    fn snapshot_reports_missing_log_files() {
        let directory = temp_directory("missing");

        let snapshot = snapshot_logs(&directory);

        assert_eq!(snapshot.directory, directory.to_string_lossy());
        assert!(!snapshot.current.exists);
        assert!(!snapshot.previous.exists);
        assert_eq!(snapshot.current.text, "");
        assert_eq!(snapshot.current.size_bytes, 0);
    }

    #[test]
    fn snapshot_reads_current_and_previous_files() {
        let directory = temp_directory("tails");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("rlive.log"), "current log").unwrap();
        fs::write(directory.join("rlive.previous.log"), "previous log").unwrap();

        let snapshot = snapshot_logs(&directory);

        assert!(snapshot.current.exists);
        assert!(snapshot.previous.exists);
        assert_eq!(snapshot.current.text, "current log");
        assert_eq!(snapshot.current.size_bytes, "current log".len() as u64);
        assert_eq!(snapshot.previous.text, "previous log");

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn diagnostics_accounts_are_local_booleans_and_database_failure_is_unknown() {
        let conn = crate::db::schema::open_in_memory().unwrap();
        crate::account::set_cookie(
            &conn,
            &SiteId::Bilibili,
            "SESSDATA=private; username=私密姓名",
        )
        .unwrap();
        crate::account::set_cookie(&conn, &SiteId::Huya, " \t\n").unwrap();
        crate::account::set_cookie(&conn, &SiteId::Douyin, "").unwrap();
        let value = serde_json::to_value(snapshot_accounts(Some(&conn))).unwrap();
        assert_eq!(
            value,
            serde_json::json!([
                {"site_id": "bilibili", "has_cookie": true, "verification": "not_checked"},
                {"site_id": "huya", "has_cookie": false, "verification": "not_checked"},
                {"site_id": "douyu", "has_cookie": false, "verification": "not_checked"},
                {"site_id": "douyin", "has_cookie": false, "verification": "not_checked"},
                {"site_id": "twitch", "has_cookie": false, "verification": "not_checked"}
            ])
        );
        let missing_table = rusqlite::Connection::open_in_memory().unwrap();
        for conn in [None, Some(&missing_table)] {
            let accounts = snapshot_accounts(conn);
            assert_eq!(accounts.len(), 5);
            assert!(accounts.iter().all(|account| account.has_cookie.is_none()));
            let value = serde_json::to_value(accounts).unwrap();
            assert!(value[0]["has_cookie"].is_null());
        }
    }

    #[test]
    fn diagnostics_missing_empty_and_unreadable_files_do_not_expose_paths() {
        let directory = temp_directory("私密 用户");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("rlive.log"), "").unwrap();
        let logs = snapshot_logs(&directory);
        let snapshot = build_snapshot(1, &logs, StreamProxy::new().telemetry_totals(), vec![]);
        assert!(snapshot.logs.current.exists);
        assert!(!snapshot.logs.current.truncated);
        assert!(!snapshot.logs.previous.exists);
        assert!(snapshot.logs.current.entries.is_empty());
        assert_eq!(snapshot.proxy.sessions, 0);
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("私密"));
        assert!(!json.contains("directory"));
        assert!(!json.contains("path"));
        // 用目录代替文件，跨平台验证无法读取时不能假装日志完整。
        let unreadable = read_tail(&directory);
        assert!(unreadable.exists);
        assert!(unreadable.truncated);
        assert!(unreadable.text.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn diagnostics_huge_line_and_credentials_split_at_window_start_are_discarded() {
        let directory = temp_directory("huge");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("rlive.log");
        fs::write(
            &path,
            format!("token=\"{}", "私密 token ".repeat(TAIL_BYTES as usize)),
        )
        .unwrap();
        let huge = read_tail(&path);
        assert!(huge.truncated);
        assert!(huge.text.is_empty());
        assert_eq!(huge.omitted_lines, 1);
        assert!(summarize_log(&huge).entries.is_empty());

        let known =
            "2026-08-30T14:51:31Z WARN rlive_lib::stream_proxy: stream proxy accept failed\n";
        // 窗口恰好落在凭据值中，凭据内伪装的日志头也随整条残行丢弃。
        let text = format!(
            "token=\"{}private-secret {known}{known}",
            "x".repeat(TAIL_BYTES as usize)
        );
        fs::write(&path, text).unwrap();
        let tail = read_tail(&path);
        assert_eq!(tail.text, known);
        assert_eq!(tail.omitted_lines, 1);
        let summary = summarize_log(&tail);
        assert_eq!(summary.entries.len(), 1);
        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("private-secret"));
        assert!(!json.contains("token"));
        fs::remove_dir_all(directory).unwrap();
    }

    /// 模拟 metadata 后增长：底层 reader 能继续提供数据，但 take 必须停止读取。
    struct GrowingReader {
        cursor: Cursor<Vec<u8>>,
        read_bytes: usize,
        fail_seek: bool,
        grown: bool,
    }

    impl Read for GrowingReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            assert!(!self.fail_seek, "seek 失败后不允许读头部");
            if !self.grown {
                self.cursor
                    .get_mut()
                    .extend(vec![b'x'; TAIL_BYTES as usize * 2]);
                self.grown = true;
            }
            let count = self.cursor.read(buffer)?;
            self.read_bytes += count;
            Ok(count)
        }
    }

    impl Seek for GrowingReader {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            if self.fail_seek {
                return Err(io::Error::other(
                    "private path must never reach the summary",
                ));
            }
            self.cursor.seek(position)
        }
    }

    #[test]
    fn diagnostics_read_window_enforces_byte_budget_despite_concurrent_growth() {
        for size in [0, 100, TAIL_BYTES, TAIL_BYTES * 2] {
            let mut reader = GrowingReader {
                cursor: Cursor::new(vec![b'\n'; size as usize]),
                read_bytes: 0,
                fail_seek: false,
                grown: false,
            };
            read_window(&mut reader, size).unwrap();
            assert_eq!(reader.read_bytes as u64, size.min(TAIL_BYTES));
        }
    }

    #[test]
    fn diagnostics_seek_failure_never_reads_from_start_and_shrink_is_truncated() {
        let mut reader = GrowingReader {
            cursor: Cursor::new(vec![b'x'; TAIL_BYTES as usize * 2]),
            read_bytes: 0,
            fail_seek: true,
            grown: false,
        };
        assert!(read_window(&mut reader, TAIL_BYTES * 2).is_err());
        assert_eq!(reader.read_bytes, 0);
        let mut shrunk = Cursor::new(Vec::new());
        let window = read_window(&mut shrunk, TAIL_BYTES * 2).unwrap();
        assert!(window.truncated);
        assert!(window.text.is_empty());
    }
}
