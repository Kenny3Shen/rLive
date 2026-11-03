//! B 站 VOD 下载命令。
//!
//! 下载队列与文件都归 `video_download::VideoDownloadManager` 所有；这里只做
//! IPC 边界，参数校验与状态流转都在管理器内部，避免命令层和 worker 各写一套。

use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::video_download::{
    VideoDownloadInput, VideoDownloadItem, VideoDownloadPlaybackInfo, VideoDownloadStatus,
};

#[tauri::command]
pub fn video_download_list(state: State<'_, AppState>) -> Vec<VideoDownloadItem> {
    state.video_download.list()
}

/// 用系统文件管理器打开下载根目录。
///
/// 前端 `openPath` 受 `opener` 能力作用域限制，未逐个登记路径时会直接返回
/// `ForbiddenPath`；这里从 Rust 侧调用已信任的 opener，既不用放宽 WebView 的
/// 通用打开能力，也能在两个平台上都打开目录本身而不是选中它。
#[tauri::command]
pub fn video_download_open_directory(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_path(state.video_download.root_path(), None::<&str>)
            .map_err(|error| {
                AppError::new(
                    "video_download_open_directory_error",
                    format!("无法打开下载目录: {error}"),
                )
            })
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (app, state);
        Err(AppError::new(
            "video_download_open_directory_unsupported",
            "当前平台不支持打开下载目录",
        ))
    }
}

#[tauri::command]
pub fn video_download_start(
    state: State<'_, AppState>,
    input: VideoDownloadInput,
) -> AppResult<VideoDownloadItem> {
    state.video_download.start(input)
}

#[tauri::command]
pub fn video_download_pause(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<VideoDownloadItem> {
    state.video_download.pause(id.trim())
}

#[tauri::command]
pub fn video_download_resume(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<VideoDownloadItem> {
    state.video_download.resume(id.trim())
}

#[tauri::command]
pub async fn video_download_playback_info(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<VideoDownloadPlaybackInfo> {
    state.video_download.playback_info(id.trim()).await
}

#[tauri::command]
pub fn video_download_watch_progress_report(
    state: State<'_, AppState>,
    id: String,
    progress: f64,
    duration: f64,
) -> AppResult<()> {
    state
        .video_download
        .report_watch_progress(id.trim(), progress, duration)
}

#[tauri::command(async)]
pub async fn video_download_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.video_download.remove(id.trim()).await
}

/// 打开已完成的成片。
///
/// 桌面端交给系统默认播放器；Android 的成片在应用私有目录，必须经
/// `FileProvider` 换成 `content://` 才能被外部播放器读取。
#[tauri::command]
pub async fn video_download_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let item = state.video_download.get(id.trim())?;
    if item.status != VideoDownloadStatus::Completed {
        return Err(AppError::new(
            "video_download_not_completed",
            "下载尚未完成，暂时无法打开",
        ));
    }
    let path = PathBuf::from(&item.file_path);
    if !path.is_file() {
        return Err(AppError::new(
            "video_download_missing",
            "下载文件已被移动或删除",
        ));
    }

    #[cfg(target_os = "android")]
    {
        crate::commands::android_video_mux::open_file(&app, &path).await
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_path(item.file_path, None::<&str>)
            .map_err(|error| {
                AppError::new(
                    "video_download_open_error",
                    format!("无法打开下载文件: {error}"),
                )
            })
    }

    #[cfg(not(any(
        target_os = "windows",
        target_os = "linux",
        target_os = "macos",
        target_os = "android"
    )))]
    {
        let _ = app;
        Err(AppError::new(
            "video_download_open_unsupported",
            "当前平台不支持打开下载文件",
        ))
    }
}
