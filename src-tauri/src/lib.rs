mod account;
mod app_paths;
#[cfg(not(target_os = "android"))]
mod asr;
mod commands;
mod danmu_rs;
mod db;
mod dlna;
mod error;
mod http_client;
mod image_cache;
mod image_proxy;
mod iptv;
mod lan_sync;
mod models;
mod profile;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
mod recording;
mod settings;
mod sites;
mod state;
mod stream_proxy;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::sync::{Arc, Mutex, MutexGuard};

use app_paths::AppDirectories;
use commands::account::{
    account_clear_cookie, account_get_cookie, account_get_profile, account_qr_login_poll,
    account_qr_login_start, account_set_cookie,
};
#[cfg(target_os = "android")]
use commands::android_player_controls::AndroidPlayerControls;
use commands::android_player_controls::{
    android_player_controls_get_state, android_player_controls_reset_brightness,
    android_player_controls_set_brightness, android_player_controls_set_immersive,
    android_player_controls_set_media_volume, android_player_controls_set_orientation,
};
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use commands::app_lifecycle::{app_confirm_exit, recording_active_count};
#[cfg(not(target_os = "android"))]
use commands::asr::{asr_disable, asr_enable, asr_get_status, asr_reset_stream, asr_transcribe};
use commands::cache::{cache_clear, cache_usage};
use commands::danmaku::{
    bilibili_danmaku_send, bilibili_danmaku_send_status, danmaku_connect, danmaku_disconnect,
    douyu_danmaku_send, douyu_danmaku_send_status, huya_danmaku_send, huya_danmaku_send_status,
};
use commands::danmaku_favorite::{
    danmaku_favorite_add, danmaku_favorite_list, danmaku_favorite_remove,
};
use commands::danmaku_send_history::{
    danmaku_send_history_clear, danmaku_send_history_clear_all, danmaku_send_history_list,
    danmaku_send_history_list_all,
};
use commands::diagnostics::{app_log_clear, app_log_snapshot};
use commands::dlna::{dlna_cast, dlna_search_devices, dlna_status, dlna_stop};
use commands::follow::{
    follow_add, follow_list, follow_refresh, follow_refresh_auto_record, follow_remove,
    follow_set_auto_record, follow_set_tags, tag_list, tag_remove, tag_upsert,
};
use commands::history::{history_add, history_clear, history_list, history_remove};
use commands::image_proxy::image_proxy_url;
use commands::iptv::{
    iptv_check_channels, iptv_favorite_add, iptv_favorite_group_list, iptv_favorite_group_remove,
    iptv_favorite_group_upsert, iptv_favorite_list, iptv_favorite_remove, iptv_favorite_set_group,
    iptv_load_playlist,
};
use commands::lan_sync::{lan_sync_receive, lan_sync_start, lan_sync_status, lan_sync_stop};
use commands::profile::{profile_export, profile_import};
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use commands::recording::{
    recording_danmaku_export_ass, recording_danmaku_url, recording_delete, recording_list,
    recording_playback_url, recording_set_continue_on_leave, recording_set_storage_path,
    recording_start, recording_stop, recording_storage_info,
};
use commands::settings::{settings_get, settings_set};
use commands::site::{
    site_get_categories, site_get_category_rooms, site_get_play_qualities, site_get_play_urls,
    site_get_recommend, site_get_room_detail, site_list, site_search_rooms,
};
use commands::stream_proxy::{
    stream_proxy_probe_sources, stream_proxy_start, stream_proxy_stop, stream_proxy_telemetry,
};
use state::AppState;
// 只有桌面端的关闭处理器会发出事件；Android 没有退出确认框。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use tauri::Emitter;
use tauri::Manager;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::MakeWriter;

const MAX_LOG_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// 录制仍在进行时发出该事件而不是关闭窗口。
/// 前端以 `app_confirm_exit` 回应，或关闭自己的对话框。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
const APP_EXIT_REQUESTED_EVENT: &str = "app-exit-requested";

/**
 * 注册直播播放器边缘手势所用的窄接口 Android 桥。Kotlin 实现负责修改
 * Activity 亮度与 Android 媒体音量流；
 * 桌面端构建保留现有的 Web 控制。
 *
 * 这里返回的 `PluginHandle` 是进入 Kotlin `@Command` 方法的*唯一*途径，
 * 因此把它存入受管状态，供 `android_player_controls_*` 应用命令使用。
 * 没有它，webview 发出的 `plugin:player-controls|…` invoke 会落到本插件
 * 自己的（空的）Rust invoke handler 上，
 * 在 Kotlin 运行之前就被拒绝。
 */
#[cfg(target_os = "android")]
fn android_player_controls_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("player-controls")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.shenss.rlive", "RlivePlayerControlsPlugin")?;
            app.manage(AndroidPlayerControls(handle));
            Ok(())
        })
        .build()
}

/// 应用日志的同步追加写入器。日志互斥锁中毒时绝不能打断播放或用户发起的
/// 聊天发送，因此在这种异常情况下写入会被安全地丢弃。
#[derive(Clone)]
struct AppLogWriter(Arc<Mutex<File>>);

struct AppLogGuard<'a>(Option<MutexGuard<'a, File>>);

impl Write for AppLogGuard<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self.0.as_mut() {
            Some(file) => file.write(buffer),
            None => Ok(buffer.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.0.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

impl<'a> MakeWriter<'a> for AppLogWriter {
    type Writer = AppLogGuard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        AppLogGuard(self.0.lock().ok())
    }
}

/// 把失败诊断持久化到本地，因为 Windows 发布版没有控制台窗口。
/// 刻意只记录结构化的错误状态：Cookie 值、token、发出的聊天文本
/// 以及成功操作的进度都绝不能写盘。
fn init_logging(directory: &std::path::Path) {
    if let Err(error) = fs::create_dir_all(directory) {
        eprintln!("rLive log directory unavailable: {error}");
        return;
    }
    let path = directory.join("rlive.log");
    if path
        .metadata()
        .map(|metadata| metadata.len() > MAX_LOG_FILE_BYTES)
        .unwrap_or(false)
    {
        let previous = directory.join("rlive.previous.log");
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(&path, previous);
    }
    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => file,
        Err(error) => {
            eprintln!("rLive log file unavailable: {error}");
            return;
        }
    };

    // 保持发布版持久日志只记录失败。特别是不要响应 `RUST_LOG`：
    // 它可能把成功的认证或连接进度变成持久的本地记录。
    let filter = EnvFilter::new("rlive_lib=warn");
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_file(true)
        .with_line_number(true)
        .with_writer(AppLogWriter(Arc::new(Mutex::new(file))))
        .try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init());
    // 仅限 Android：为播放器边缘手势提供窗口亮度、STREAM_MUSIC 音量
    // 和全屏方向控制。桌面端沿用 Web 播放器的音量控制。
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_player_controls_plugin());

    builder
        .setup(|app| {
            // `dirs` 没有 Android 应用沙箱解析器，在该平台上可能解析出不可写的相对
            // 路径。在任何启动 I/O 之前，先向 Tauri 移动宿主请求
            // Android 的私有数据目录。
            #[cfg(target_os = "android")]
            let app_data_dir = app.path().app_data_dir().map_err(|error| {
                error::AppError::new(
                    "app_data_dir_error",
                    format!("resolve Android app data directory: {error}"),
                )
            })?;

            #[cfg(target_os = "android")]
            let directories = AppDirectories::resolve(&app_data_dir)?;
            #[cfg(not(target_os = "android"))]
            let directories = AppDirectories::resolve()?;

            init_logging(&directories.logs);
            let state = AppState::init(&directories)?;
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            state.recording.attach_app_handle(app.handle().clone());
            app.manage(state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
            #[cfg(not(target_os = "android"))]
            asr_get_status,
            #[cfg(not(target_os = "android"))]
            asr_enable,
            #[cfg(not(target_os = "android"))]
            asr_disable,
            #[cfg(not(target_os = "android"))]
            asr_reset_stream,
            #[cfg(not(target_os = "android"))]
            asr_transcribe,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_list,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_start,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_stop,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_set_continue_on_leave,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_delete,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_playback_url,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_storage_info,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_set_storage_path,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_danmaku_url,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_danmaku_export_ass,
            account_get_cookie,
            account_get_profile,
            account_set_cookie,
            account_clear_cookie,
            account_qr_login_start,
            account_qr_login_poll,
            site_list,
            site_get_categories,
            site_get_recommend,
            site_get_category_rooms,
            site_search_rooms,
            site_get_room_detail,
            site_get_play_qualities,
            site_get_play_urls,
            history_list,
            history_add,
            history_clear,
            history_remove,
            iptv_load_playlist,
            iptv_check_channels,
            iptv_favorite_list,
            iptv_favorite_add,
            iptv_favorite_remove,
            iptv_favorite_group_list,
            iptv_favorite_group_upsert,
            iptv_favorite_group_remove,
            iptv_favorite_set_group,
            stream_proxy_start,
            stream_proxy_stop,
            stream_proxy_probe_sources,
            stream_proxy_telemetry,
            image_proxy_url,
            cache_usage,
            cache_clear,
            danmaku_connect,
            danmaku_disconnect,
            bilibili_danmaku_send_status,
            bilibili_danmaku_send,
            douyu_danmaku_send_status,
            douyu_danmaku_send,
            huya_danmaku_send_status,
            huya_danmaku_send,
            danmaku_favorite_list,
            danmaku_favorite_add,
            danmaku_favorite_remove,
            danmaku_send_history_list,
            danmaku_send_history_list_all,
            danmaku_send_history_clear,
            danmaku_send_history_clear_all,
            follow_list,
            follow_add,
            follow_remove,
            follow_set_tags,
            follow_set_auto_record,
            follow_refresh,
            follow_refresh_auto_record,
            tag_list,
            tag_upsert,
            tag_remove,
            profile_export,
            profile_import,
            dlna_cast,
            dlna_search_devices,
            dlna_status,
            dlna_stop,
            lan_sync_start,
            lan_sync_status,
            lan_sync_stop,
            lan_sync_receive,
            android_player_controls_get_state,
            android_player_controls_set_media_volume,
            android_player_controls_set_brightness,
            android_player_controls_reset_brightness,
            android_player_controls_set_orientation,
            android_player_controls_set_immersive,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_active_count,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            app_confirm_exit,
            app_log_snapshot,
            app_log_clear,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                // 总是先阻止关闭：从处理器内部发起退出正是让关机路径完成收尾工作的方式，
                // 而活动中的录制还需要用户的答复。
                api.prevent_close();
                #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
                if let Some(state) = app_handle.try_state::<AppState>()
                    && state.inner().recording.active_count() > 0
                    && app_handle.emit(APP_EXIT_REQUESTED_EVENT, ()).is_ok()
                {
                    // 从这里开始决定权在前端：它要么调用 `app_confirm_exit`，
                    // 要么让窗口保持打开。事件发送失败意味着没有任何 webview 能回应，
                    // 于是直接落回并退出。
                    return;
                }
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let state = state.inner();
                    state.stream_proxy.stop();
                    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
                    state.recording.stop_all();
                    state.image_proxy.stop();
                    state.lan_sync.stop();
                    state.danmaku.disconnect();
                }
                std::process::exit(0);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } if label == "main" => {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.inner().stream_proxy.stop();
                    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
                    state.inner().recording.stop_all();
                    state.inner().image_proxy.stop();
                    state.inner().lan_sync.stop();
                }
            }
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let state = state.inner();
                    state.stream_proxy.stop();
                    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
                    state.recording.stop_all();
                    state.image_proxy.stop();
                    state.lan_sync.stop();
                    state.danmaku.disconnect();
                }
            }
            _ => {}
        });
}
