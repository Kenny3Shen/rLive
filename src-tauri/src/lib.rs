// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod account;
mod commands;
mod db;
mod error;
mod http_client;
mod models;
mod player;
mod settings;
mod sites;
mod state;

use commands::account::{account_clear_cookie, account_get_cookie, account_set_cookie};
use commands::history::{history_add, history_clear, history_list};
use commands::player::{
    player_load, player_open, player_set_pause, player_set_volume, player_status, player_stop,
};
use commands::settings::{settings_get, settings_set};
use commands::site::{
    site_get_categories, site_get_category_rooms, site_get_play_qualities, site_get_play_urls,
    site_get_recommend, site_get_room_detail, site_list, site_search_rooms,
};
use state::AppState;
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = AppState::init()?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
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
            player_open,
            player_load,
            player_stop,
            player_set_pause,
            player_set_volume,
            player_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let _ = state.player.stop();
                }
            }
        });
}
