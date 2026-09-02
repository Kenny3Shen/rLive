//! 为"关于"设置面板提供本地应用日志的只读访问。
//!
//! Windows 发布版没有控制台，因此 `rlive.log` 是用户能提交的唯一失败记录。
//! 这些命令让"关于"面板可以展示该日志的尾部并打开其所在目录，
//! 而无需前端自己获得文件系统权限。
//!
//! 该日志在设计上只记录失败（参见 `init_logging`）：Cookie 值、token 和
//! 发出的聊天文本都不会写入其中，因此把它展示在 UI 上不会泄露凭据。

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 从日志文件末尾读取的字节数。日志本身在 2 MiB 时轮转，但 webview 不应
/// 一次收到那么多文本：反馈问题需要的是最近的警告，
/// 而完整文件只需一次点击即可在目录中打开。
const TAIL_BYTES: u64 = 256 * 1024;

/// 一个日志文件的尾部内容，以及面板要展示的元数据。
#[derive(Debug, Serialize)]
pub struct LogFileContent {
    /// 绝对路径，展示出来便于用户在关闭应用后找到该文件。
    pub path: String,
    /// 文件是否已存在。全新安装完全没有日志。
    pub exists: bool,
    /// 磁盘上的完整大小，便于面板说明当前视图是截断的。
    pub size_bytes: u64,
    /// 当 `size_bytes` 超过尾部窗口、文本被截断时为 true。
    pub truncated: bool,
    /// 尾部内容本身，最旧的一行在前。
    pub text: String,
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

/// 读取某个日志文件最后 `TAIL_BYTES` 字节。
///
/// 文件不存在属于正常状态而不是错误：说明还没有出过问题。
/// 用 seek 而不是整文件读取，可让 2 MiB 的轮转日志开销保持很低。
fn read_tail(path: &std::path::Path) -> LogFileContent {
    // `AppDirectories::resolve` 会做规范化，在 Windows 上得到 verbatim 形式的
    // `\\?\D:\…` 路径。该前缀属于 API 细节，不应展示给用户或让其手动输入，
    // 因此所有经 IPC 传出的路径都会被规范化。
    let display = crate::app_paths::path_to_string(path);
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
        // 忽略 seek 失败：从头开始读取仍然有用。
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
    // 尾部可能从某一行的中间开始，且多字节字符可能横跨 seek 偏移，
    // 因此采用有损解码并丢弃第一行不完整内容。
    let mut text = String::from_utf8_lossy(&buffer).into_owned();
    if truncated && let Some(newline) = text.find('\n') {
        text = text[newline + 1..].to_owned();
    }
    LogFileContent {
        path: display,
        exists: true,
        size_bytes: size,
        truncated,
        text,
    }
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
    Ok(snapshot_logs(&state.directories.logs))
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

#[cfg(test)]
mod tests {
    use super::snapshot_logs;
    use std::fs;
    use std::path::PathBuf;

    use uuid::Uuid;

    fn temp_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("rlive-app-log-{label}-{}", Uuid::new_v4().simple()))
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
}
