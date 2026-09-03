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

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::Local;

use app_paths::AppDirectories;
use commands::account::{
    account_clear_cookie, account_get_cookie, account_get_profile, account_qr_login_poll,
    account_qr_login_start, account_set_cookie,
};
#[cfg(target_os = "android")]
use commands::android_navigation::AndroidNavigation;
use commands::android_navigation::android_move_task_to_back;
#[cfg(target_os = "android")]
use commands::android_player_controls::AndroidPlayerControls;
use commands::android_player_controls::{
    android_player_controls_get_state, android_player_controls_reset_brightness,
    android_player_controls_set_brightness, android_player_controls_set_immersive,
    android_player_controls_set_media_volume, android_player_controls_set_orientation,
};
#[cfg(target_os = "android")]
use commands::android_system_bars::AndroidSystemBars;
use commands::android_system_bars::android_system_bars_set_appearance;
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
use commands::stream_proxy::{stream_proxy_start, stream_proxy_stop, stream_proxy_telemetry};
use commands::video::{
    video_get_archive, video_get_comment_replies, video_get_comments, video_get_danmaku,
    video_get_pgc_index, video_get_pgc_zone, video_get_play_info, video_get_popular,
    video_get_recommend, video_get_related, video_get_season, video_get_zone, video_stop_play,
    video_zone_list,
};
use state::AppState;
// 只有桌面端的关闭处理器会发出事件；Android 没有退出确认框。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use tauri::Emitter;
use tauri::Manager;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::fmt::time::FormatTime;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;

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

/**
 * Android 返回键的应用级语义桥（见 `commands/android_navigation`）。
 * 页面在底部导航根路由上消费不了返回事件时，经它把应用退回系统桌面。
 */
#[cfg(target_os = "android")]
fn android_back_navigation_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("back-navigation")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.shenss.rlive", "RliveBackNavigationPlugin")?;
            app.manage(AndroidNavigation(handle));
            Ok(())
        })
        .build()
}

/**
 * 应用亮暗主题到 Android 系统栏图标外观的桥（见 `commands/android_system_bars`）。
 * 应用主题存在 WebView 的 localStorage，Kotlin 读不到；前端每次应用主题时
 * 把 resolved 亮暗经这里同步给原生。
 */
#[cfg(target_os = "android")]
fn android_system_bars_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("system-bars")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.shenss.rlive", "RliveSystemBarsPlugin")?;
            app.manage(AndroidSystemBars(handle));
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

/// 日志时间戳格式：本地时间 + 明确的 UTC 偏移，例如
/// `2026-08-30T22:51:31.577554+08:00`。保留 ISO-8601 的字段顺序，
/// 因此按字符串排序仍等价于按时间排序；带上偏移量则让用户在跨时区
/// 提交日志时不会丢失原始时区信息。
const LOG_TIME_FORMAT: &str = "%Y-%m-%dT%H:%M:%S%.6f%:z";

/// 按系统时区渲染事件时间的计时器。
///
/// `tracing_subscriber` 默认的 `SystemTime` 只输出 UTC（末尾 `Z`），
/// 用户对着本地时钟读日志时会凭空偏移一个时区（例如 CST 差 8 小时），
/// 无法与录制文件名或用户描述的故障时刻对齐。
///
/// 这里用 chrono 而不是 `tracing-subscriber` 的 `local-time` feature：
/// 后者依赖的 `time` crate 在多线程进程中拒绝解析本地时区并静默退回 UTC，
/// 而日志初始化发生在 Tauri 启动 runtime 线程之后。chrono 经
/// `iana-time-zone` 读取系统时区，在桌面端与 Android 上都成立。
#[derive(Clone, Copy, Default)]
struct LocalTimeFormat;

impl FormatTime for LocalTimeFormat {
    fn format_time(&self, writer: &mut tracing_subscriber::fmt::format::Writer<'_>) -> fmt::Result {
        write!(writer, "{}", Local::now().format(LOG_TIME_FORMAT))
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

    let filter = file_log_filter();
    let _ = tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_timer(LocalTimeFormat)
                .with_file(true)
                .with_line_number(true)
                .with_writer(AppLogWriter(Arc::new(Mutex::new(file)))),
        )
        .with(filter)
        .try_init();
}

/// 发布版持久日志的过滤规则：仅记录 `rlive_lib` 自身的 WARN 及以上。
/// 刻意不响应 `RUST_LOG`：它可能把成功的认证或连接进度变成持久的本地
/// 记录。与固定串 `EnvFilter::new("rlive_lib=warn")` 语义等价
/// （未列出的 target 全部关闭），但无需 env-filter feature
/// 的动态过滤机制。
fn file_log_filter() -> Targets {
    Targets::new().with_target("rlive_lib", LevelFilter::WARN)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init());
    // 仅限 Android：为播放器边缘手势提供窗口亮度、STREAM_MUSIC 音量
    // 和全屏方向控制；为返回键提供退回系统桌面的应用级桥；并把应用
    // 亮暗主题同步到系统栏图标外观。
    // 桌面端沿用 Web 播放器的音量控制。
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(android_player_controls_plugin())
        .plugin(android_back_navigation_plugin())
        .plugin(android_system_bars_plugin());

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
            stream_proxy_telemetry,
            video_get_recommend,
            video_get_popular,
            video_get_zone,
            video_zone_list,
            video_get_pgc_index,
            video_get_pgc_zone,
            video_get_season,
            video_get_play_info,
            video_get_danmaku,
            video_get_related,
            video_get_archive,
            video_get_comments,
            video_get_comment_replies,
            video_stop_play,
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
            android_system_bars_set_appearance,
            android_move_task_to_back,
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

#[cfg(test)]
mod tests {
    use super::{LOG_TIME_FORMAT, LocalTimeFormat, file_log_filter, init_logging};
    use chrono::{Local, Utc};
    use std::sync::Mutex;
    use tracing::Subscriber;
    use tracing_subscriber::fmt::time::FormatTime;
    use tracing_subscriber::layer::Context;
    use tracing_subscriber::prelude::*;

    /// 记录穿透过滤层的事件，验证持久日志只放行 `rlive_lib` 的 WARN+。
    #[derive(Default, Clone)]
    struct Recorder {
        events: std::sync::Arc<Mutex<Vec<(&'static str, tracing::Level)>>>,
    }

    impl<S: Subscriber> tracing_subscriber::Layer<S> for Recorder {
        fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
            let metadata = event.metadata();
            self.events
                .lock()
                .unwrap()
                .push((metadata.target(), *metadata.level()));
        }
    }

    #[test]
    fn file_log_filter_keeps_only_rlive_lib_warnings() {
        let recorder = Recorder::default();
        let subscriber = tracing_subscriber::registry()
            .with(file_log_filter())
            .with(recorder.clone());

        let dispatch = tracing::dispatcher::Dispatch::new(subscriber);
        tracing::dispatcher::with_default(&dispatch, || {
            tracing::warn!(target: "rlive_lib", "保留：自身警告");
            tracing::error!(target: "rlive_lib", "保留：自身错误");
            tracing::info!(target: "rlive_lib", "丢弃：自身信息");
            tracing::warn!(target: "reqwest", "丢弃：外部警告");
            tracing::error!(target: "tungstenite", "丢弃：外部错误");
        });

        let events = recorder.events.lock().unwrap();
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0], ("rlive_lib", tracing::Level::WARN));
        assert_eq!(events[1], ("rlive_lib", tracing::Level::ERROR));
    }

    /// 日志时间戳必须是本地时间并带上偏移量，而不是 `SystemTime` 默认的 UTC。
    /// 在 UTC 偏移非零的机器上，这条断言直接覆盖原始 bug：写下的墙钟
    /// 与 UTC 墙钟不同。
    #[test]
    fn log_timestamps_follow_the_system_time_zone() {
        let mut buffer = String::new();
        let mut writer = tracing_subscriber::fmt::format::Writer::new(&mut buffer);

        LocalTimeFormat.format_time(&mut writer).unwrap();

        let offset = Local::now().offset().to_string();
        assert!(
            buffer.ends_with(&offset),
            "时间戳 {buffer} 应以本地偏移 {offset} 结尾"
        );
        assert!(!buffer.ends_with('Z'), "时间戳 {buffer} 不应是 UTC");

        // 同一时刻的本地与 UTC 渲染只在偏移为 0 时相同。
        let now = Utc::now();
        let local_wall_clock = now
            .with_timezone(&Local)
            .format(LOG_TIME_FORMAT)
            .to_string();
        let utc_wall_clock = now.format(LOG_TIME_FORMAT).to_string();
        if Local::now().offset().to_string() == "+00:00" {
            assert_eq!(local_wall_clock, utc_wall_clock);
        } else {
            assert_ne!(local_wall_clock, utc_wall_clock);
        }
    }

    /// 计时器确实被接入写盘的 fmt 层：只验证 `LocalTimeFormat` 本身不能
    /// 防止有人日后删掉 `with_timer`，因此这里直接走 `init_logging` 并
    /// 回读 `rlive.log`。
    #[test]
    fn written_log_lines_carry_the_local_time_offset() {
        let directory =
            std::env::temp_dir().join(format!("rlive-log-timer-{}", uuid::Uuid::new_v4().simple()));

        init_logging(&directory);
        tracing::warn!(target: "rlive_lib", "时区写盘校验");

        let text = std::fs::read_to_string(directory.join("rlive.log")).unwrap();
        let line = text
            .lines()
            .find(|line| line.contains("时区写盘校验"))
            .expect("警告应已写入日志文件");
        let timestamp = line.split_whitespace().next().unwrap();
        let offset = Local::now().offset().to_string();
        assert!(
            timestamp.ends_with(&offset),
            "日志行 {line} 的时间戳应带本地偏移 {offset}"
        );

        std::fs::remove_dir_all(directory).unwrap();
    }
}
