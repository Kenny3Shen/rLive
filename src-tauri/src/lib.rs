mod account;
mod commands;
mod danmaku;
mod db;
mod error;
mod http_client;
mod models;
mod player;
mod profile;
mod settings;
mod sites;
mod state;
mod stream_proxy;

use commands::account::{account_clear_cookie, account_get_cookie, account_set_cookie};
use commands::danmaku::{danmaku_connect, danmaku_disconnect};
use commands::follow::{
    follow_add, follow_list, follow_refresh, follow_remove, follow_set_tags, tag_list, tag_remove,
    tag_upsert,
};
use commands::history::{history_add, history_clear, history_list};
use commands::overlay::{
    destroy_overlay, handle_overlay_focus, overlay_begin, overlay_close, overlay_open,
    overlay_set_bounds, OverlayLifecycle,
};
use commands::player::{
    destroy_player, player_begin, player_debug_lifecycle, player_enter_fullscreen,
    player_exit_fullscreen, player_load, player_open, player_set_bounds, player_set_pause,
    player_set_volume, player_show_danmaku, player_status, player_stop,
};
use commands::stream_proxy::{stream_proxy_start, stream_proxy_stop};
use player::PlayerLifecycle;
use commands::profile::{profile_export, profile_import};
use commands::settings::{settings_get, settings_set};
use commands::site::{
    site_get_categories, site_get_category_rooms, site_get_play_qualities, site_get_play_urls,
    site_get_recommend, site_get_room_detail, site_list, site_search_rooms,
};
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // MCP Bridge (https://github.com/hypothesi/mcp-server-tauri): localhost only.
    // Required for driver_session / ipc_monitor / webview_screenshot while debugging.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );

    builder
        .setup(|app| {
            let state = AppState::init()?;
            app.manage(state);
            app.manage(OverlayLifecycle::default());
            app.manage(PlayerLifecycle::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
            account_get_cookie,
            account_set_cookie,
            account_clear_cookie,
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
            player_begin,
            player_open,
            player_load,
            player_stop,
            player_debug_lifecycle,
            player_set_pause,
            player_set_volume,
            player_set_bounds,
            player_show_danmaku,
            player_status,
            player_enter_fullscreen,
            player_exit_fullscreen,
            stream_proxy_start,
            stream_proxy_stop,
            overlay_begin,
            overlay_open,
            overlay_set_bounds,
            overlay_close,
            danmaku_connect,
            danmaku_disconnect,
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Focused(focused),
                ..
            } => handle_overlay_focus(app_handle, &label, focused),
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                // In-process engine stop is synchronous and non-blocking (no
                // external mpv wait).  Still prevent_close + exit so WebView2
                // teardown cannot hang the UI after media is gone.
                api.prevent_close();
                destroy_player(app_handle);
                destroy_overlay(app_handle);
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
                destroy_player(app_handle);
                destroy_overlay(app_handle);
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.inner().stream_proxy.stop();
                }
            }
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                destroy_player(app_handle);
                destroy_overlay(app_handle);
                // State<'_, T> must be accessed via .inner() for field use on all platforms.
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let state = state.inner();
                    state.stream_proxy.stop();
                    state.danmaku.disconnect();
                }
            }
            _ => {}
        });
}
