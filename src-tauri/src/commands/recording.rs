//! 桌面端录制与本地录制库的 Tauri 命令。

#![cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]

use std::time::Duration;
use tauri::State;

use crate::db::recording_watch::{self, RecordingWatchProgress};
use crate::error::{AppError, AppResult};
use crate::recording::{
    AssExportOptions, FfmpegRecordingOptions, RecordingItem, RecordingStartInput,
    RecordingStorageInfo,
};
use crate::state::AppState;

fn configured_recording_options(
    state: &AppState,
) -> AppResult<(Option<String>, FfmpegRecordingOptions, bool, usize)> {
    let conn = state.conn()?;
    let settings = crate::settings::get(&conn)?;
    Ok((
        settings.proxy,
        FfmpegRecordingOptions {
            rw_timeout_seconds: settings.ffmpeg_rw_timeout_seconds,
            reconnect_delay_max_seconds: settings.ffmpeg_reconnect_delay_max_seconds,
            hls_segment_retry_count: settings.ffmpeg_hls_segment_retry_count,
            split_duration: (settings.recording_auto_split_minutes > 0).then(|| {
                Duration::from_secs(u64::from(settings.recording_auto_split_minutes) * 60)
            }),
        },
        settings.recording_include_danmaku,
        settings.recording_max_concurrent as usize,
    ))
}

#[tauri::command]
pub fn recording_list(state: State<'_, AppState>) -> AppResult<Vec<RecordingItem>> {
    state.recording.list()
}

#[tauri::command(async)]
pub async fn recording_start(
    state: State<'_, AppState>,
    input: RecordingStartInput,
) -> AppResult<RecordingItem> {
    // 在查询设置和准备存储之前先登记后台弹幕的归属，
    // 这样并发的路由清理就不会在本次启动请求仍在准备会话时
    // 拆掉房间连接。
    let _danmaku_start_reservation = state.recording.reserve_background_danmaku_start(
        input.source_key.trim(),
        input.include_danmaku != Some(false) && input.continue_on_leave != Some(false),
    );
    let (proxy, ffmpeg_options, default_include_danmaku, max_concurrent) =
        configured_recording_options(state.inner())?;
    let input = input.with_recording_defaults(default_include_danmaku);
    state
        .recording
        .start_with_ffmpeg_options(input, proxy.as_deref(), ffmpeg_options, max_concurrent)
        .await
}

#[tauri::command(async)]
pub async fn recording_stop(state: State<'_, AppState>, id: String) -> AppResult<RecordingItem> {
    state.recording.stop(id.trim()).await
}

/// 在用户仍处于房间页时，切换进行中录制的"离开后继续"标记。离开拦截会为它的
/// "继续录制并离开"操作调用该命令，使弹幕伴生任务在播放器页卸载后
/// 继续收集，而不是丢掉房间连接。
#[tauri::command]
pub fn recording_set_continue_on_leave(
    state: State<'_, AppState>,
    id: String,
    continue_on_leave: bool,
) -> AppResult<RecordingItem> {
    state
        .recording
        .set_continue_on_leave(id.trim(), continue_on_leave)
}

#[tauri::command]
pub fn recording_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let id = id.trim();
    state.recording.delete(id)?;
    // 录像已经删掉之后，进度行的清理失败不能让整个删除报错：
    // 那会让用户误以为删失败；留下的孤行由保留上限兜底汰汰，记警告即可。
    // 清理用的 id 必须与删除用的同一个（trim 后），否则清错行。
    if let Err(error) = state.conn().and_then(|conn| recording_watch::remove(&conn, id)) {
        tracing::warn!(recording_id = %id, error = %error, "删除录制的观看进度行失败");
    }
    Ok(())
}

#[tauri::command(async)]
pub async fn recording_playback_url(state: State<'_, AppState>, id: String) -> AppResult<String> {
    state.recording.playback_url(id.trim()).await
}

#[tauri::command]
pub fn recording_storage_info(state: State<'_, AppState>) -> AppResult<RecordingStorageInfo> {
    Ok(state.recording.storage_info())
}

#[tauri::command]
pub fn recording_set_storage_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> AppResult<RecordingStorageInfo> {
    state.recording.set_storage_path(path)
}

#[tauri::command(async)]
pub async fn recording_danmaku_url(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Option<String>> {
    state.recording.danmaku_url(id.trim()).await
}

/// 在录制的媒体文件旁写出 ASS 字幕，使外部播放器能加载录制的弹幕。
/// 外观、排版和过滤使用独立的录制 ASS 设置。
#[tauri::command(async)]
pub async fn recording_danmaku_export_ass(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<String> {
    let options = {
        let conn = state.conn()?;
        AssExportOptions::try_from_settings(&crate::settings::get(&conn)?).map_err(|error| {
            AppError::new(
                "recording_ass_invalid_regex",
                format!("ASS 弹幕屏蔽正则表达式无效: {error}"),
            )
        })?
    };
    state.recording.export_danmaku_ass(id.trim(), options).await
}

/// 本地录制回放的观看进度（断点续播）。回放页进入时 `find` 决定跳回的位置，
/// 播放期间前端节流心跳 `report` 落盘，列表页用 `list` 画卡片的续播状态；
/// 上报节流刻意放在前端（心跳间隔由播放器掌握），后端只负责落盘与修剪。
#[tauri::command]
pub fn recording_watch_progress_list(
    state: State<'_, AppState>,
) -> AppResult<Vec<RecordingWatchProgress>> {
    let conn = state.conn()?;
    recording_watch::list(&conn)
}

#[tauri::command]
pub fn recording_watch_progress_find(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Option<RecordingWatchProgress>> {
    let conn = state.conn()?;
    recording_watch::find(&conn, id.trim())
}

#[tauri::command]
pub fn recording_watch_progress_report(
    state: State<'_, AppState>,
    item: RecordingWatchProgress,
) -> AppResult<()> {
    let conn = state.conn()?;
    recording_watch::upsert(&conn, item)
}
