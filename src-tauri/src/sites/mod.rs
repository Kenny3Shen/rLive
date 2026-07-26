pub mod bilibili;
pub mod douyin;
pub mod douyu;
pub mod huya;
pub mod kuaishou;
pub mod registry;
pub mod traits;
pub mod twitch;

pub use registry::{all, is_ready, site_with_proxy};
#[allow(unused_imports)] // public API for site consumers (Task 6+)
pub use traits::LiveSite;
