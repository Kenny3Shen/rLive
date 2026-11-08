pub mod danmaku_favorite;
pub mod danmaku_send_history;
pub mod follow;
pub mod history;
pub mod iptv_favorite;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub mod recording_watch;
pub mod schema;
pub mod video_follow;
pub mod video_history;

pub use schema::Db;
