mod account;
mod app_paths;
#[cfg(not(target_os = "android"))]
mod asr;
mod commands;
mod danmu_rs;
mod db;
mod error;
mod http_client;
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
use commands::app_data::{app_data_set_storage_path, app_data_storage_info};
#[cfg(not(target_os = "android"))]
use commands::asr::{asr_disable, asr_enable, asr_get_status, asr_reset_stream, asr_transcribe};
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
use commands::follow::{
    follow_add, follow_list, follow_refresh, follow_remove, follow_set_tags, tag_list, tag_remove,
    tag_upsert,
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
    recording_danmaku_url, recording_delete, recording_list, recording_playback_url,
    recording_set_storage_path, recording_start, recording_stop, recording_storage_info,
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
use tauri::Manager;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::MakeWriter;

const MAX_LOG_FILE_BYTES: u64 = 2 * 1024 * 1024;

/**
 * Registers the narrow Android bridge used by the live-player edge gestures.
 * The Kotlin implementation changes the Activity brightness and Android media
 * stream; desktop builds retain their existing web controls.
 *
 * The `PluginHandle` returned here is the *only* way into the Kotlin
 * `@Command` methods, so it is stored in managed state for the
 * `android_player_controls_*` app commands to use. Without it the webview's
 * `plugin:player-controls|…` invokes would land on this plugin's own (empty)
 * Rust invoke handler and be rejected before Kotlin ever ran.
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

/// A synchronized append-only writer for the app log. A poisoned log mutex
/// must never interrupt playback or a user-initiated chat send, so writes are
/// safely discarded in that exceptional case.
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

/// Persist failure diagnostics locally because release Windows builds have no
/// console window. Deliberately log structured error state only: Cookie
/// values, tokens, outgoing chat text, and successful operation progress must
/// never be written to disk.
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

    // Keep the persistent release log failure-only. In particular, do not
    // honor `RUST_LOG` here: it could turn successful authentication or
    // connection progress into durable local records.
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
    // Android-only: window brightness, STREAM_MUSIC volume, and fullscreen
    // orientation for player edge gestures. Desktop keeps web-player volume.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_player_controls_plugin());

    builder
        .setup(|app| {
            // `dirs` has no Android app-sandbox resolver and can resolve to
            // an unwritable relative path there. Ask the Tauri mobile host
            // for Android's private data directory before any startup I/O.
            #[cfg(target_os = "android")]
            let app_data_dir = app.path().app_data_dir().map_err(|error| {
                error::AppError::new(
                    "app_data_dir_error",
                    format!("resolve Android app data directory: {error}"),
                )
            })?;

            #[cfg(target_os = "android")]
            let directories = AppDirectories::resolve(Some(&app_data_dir))?;
            #[cfg(not(target_os = "android"))]
            let directories = AppDirectories::resolve(None)?;

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
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            app_data_storage_info,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            app_data_set_storage_path,
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
            recording_delete,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_playback_url,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_storage_info,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_set_storage_path,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording_danmaku_url,
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
            follow_refresh,
            tag_list,
            tag_upsert,
            tag_remove,
            profile_export,
            profile_import,
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                api.prevent_close();
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
