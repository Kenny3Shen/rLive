pub mod bilibili;
pub mod douyin;
pub mod douyu;
pub mod huya;
pub mod kuaishou;
pub mod registry;
pub mod traits;

pub use registry::{all, is_ready, site};
#[allow(unused_imports)] // public API for site consumers (Task 6+)
pub use traits::LiveSite;
