pub mod account;
pub mod android_navigation;
pub mod android_player_controls;
pub mod android_system_bars;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub mod app_lifecycle;
#[cfg(not(target_os = "android"))]
pub mod asr;
pub mod cache;
pub mod danmaku;
pub mod danmaku_favorite;
pub mod danmaku_send_history;
pub mod diagnostics;
pub mod dlna;
pub mod follow;
pub mod history;
pub mod image_proxy;
pub mod iptv;
pub mod lan_sync;
pub mod profile;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub mod recording;
pub mod settings;
pub mod site;
pub mod stream_proxy;
