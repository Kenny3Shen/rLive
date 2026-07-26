mod account;
mod commands;
mod danmaku;
mod db;
mod error;
mod http_client;
mod models;
mod profile;
mod settings;
mod sites;
mod state;
mod stream_proxy;

use commands::account::{account_clear_cookie, account_get_cookie, account_set_cookie};
use commands::danmaku::{
    bilibili_danmaku_send, bilibili_danmaku_send_status, danmaku_connect, danmaku_disconnect,
};
use commands::follow::{
    follow_add, follow_list, follow_refresh, follow_remove, follow_set_tags, tag_list, tag_remove,
    tag_upsert,
};
use commands::history::{history_add, history_clear, history_list};
use commands::profile::{profile_export, profile_import};
use commands::settings::{settings_get, settings_set};
use commands::site::{
    site_get_categories, site_get_category_rooms, site_get_play_qualities, site_get_play_urls,
    site_get_recommend, site_get_room_detail, site_list, site_search_rooms,
};
use commands::stream_proxy::{stream_proxy_start, stream_proxy_stop};
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The MCP bridge is useful for local development automation. It is never
    // included in a release process: release commands can access local account
    // data and the Bilibili write command, which must remain behind the
    // app's own local permission and user-operated UI entry.
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    builder
        .setup(|app| {
            let state = AppState::init()?;
            app.manage(state);
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
            stream_proxy_start,
            stream_proxy_stop,
            danmaku_connect,
            danmaku_disconnect,
            bilibili_danmaku_send_status,
            bilibili_danmaku_send,
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
