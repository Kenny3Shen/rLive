mod account;
mod commands;
mod danmaku;
mod db;
mod error;
mod http_client;
mod iptv;
mod models;
mod profile;
mod settings;
mod sites;
mod state;
mod stream_proxy;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use commands::account::{
    account_clear_cookie, account_get_cookie, account_get_profile, account_qr_login_poll,
    account_qr_login_start, account_set_cookie,
};
#[cfg(target_os = "android")]
use commands::android_player_controls::AndroidPlayerControls;
use commands::android_player_controls::{
    android_player_controls_get_state, android_player_controls_reset_brightness,
    android_player_controls_set_brightness, android_player_controls_set_media_volume,
    android_player_controls_set_orientation,
};
use commands::danmaku::{
    bilibili_danmaku_send, bilibili_danmaku_send_status, danmaku_connect, danmaku_disconnect,
    douyin_danmaku_send, douyin_danmaku_send_status, douyu_danmaku_send,
    douyu_danmaku_send_status, huya_danmaku_send, huya_danmaku_send_status,
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
use commands::iptv::iptv_load_playlist;
use commands::profile::{profile_export, profile_import};
use commands::settings::{settings_get, settings_set};
use commands::site::{
    site_get_categories, site_get_category_rooms, site_get_play_qualities, site_get_play_urls,
    site_get_recommend, site_get_room_detail, site_list, site_search_rooms,
};
use commands::stream_proxy::{stream_proxy_start, stream_proxy_stop};
use state::AppState;
use tauri::Manager;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::MakeWriter;

const MAX_LOG_FILE_BYTES: u64 = 2 * 1024 * 1024;

/**
 * Registers the narrow Android bridge used by the live-player edge gestures.
 * The Kotlin implementation changes only this Activity's brightness and the
 * Android media stream; desktop builds retain their existing web controls.
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
            let handle = api.register_android_plugin("com.shenss.rlive", "RlivePlayerControlsPlugin")?;
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

fn app_log_directory() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("rlive")
        .join("logs")
}

/// Persist failure diagnostics locally because release Windows builds have no
/// console window. Deliberately log structured error state only: Cookie
/// values, tokens, outgoing chat text, and successful operation progress must
/// never be written to disk.
fn init_logging(directory: Option<PathBuf>) {
    let directory = directory.unwrap_or_else(app_log_directory);
    if let Err(error) = fs::create_dir_all(&directory) {
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
    #[cfg(debug_assertions)]
    let devtools = tauri_plugin_devtools::init();

    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = builder.plugin(devtools);

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());
    // Android-only: brightness / STREAM_MUSIC volume for player edge gestures.
    // Desktop and browser builds keep the existing web player controls.
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
            init_logging(Some(app_data_dir.join("rlive").join("logs")));
            #[cfg(not(target_os = "android"))]
            init_logging(None);

            #[cfg(target_os = "android")]
            let state = AppState::init(Some(&app_data_dir))?;
            #[cfg(not(target_os = "android"))]
            let state = AppState::init(None)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
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
            stream_proxy_start,
            stream_proxy_stop,
            danmaku_connect,
            danmaku_disconnect,
            bilibili_danmaku_send_status,
            bilibili_danmaku_send,
            douyin_danmaku_send_status,
            douyin_danmaku_send,
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
            android_player_controls_get_state,
            android_player_controls_set_media_volume,
            android_player_controls_set_brightness,
            android_player_controls_reset_brightness,
            android_player_controls_set_orientation,
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
                }
            }
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let state = state.inner();
                    state.stream_proxy.stop();
                    state.danmaku.disconnect();
                }
            }
            _ => {}
        });
}
