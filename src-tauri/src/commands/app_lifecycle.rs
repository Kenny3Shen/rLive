//! 桌面窗口的退出确认。
//!
//! 录制在离开其页面后仍继续运行，因此关闭窗口可能丢弃用户仍需要的录制内容。
//! 只要有任务在进行，窗口关闭处理器就会先询问前端；
//! 这两个命令就是前端可以给出的两种回答。

#![cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

/// 当前正在录制媒体的任务数量。
///
/// 关闭处理器询问时由退出对话框读取该值，因为前端的录制列表只是缓存、
/// 背后的轮询较慢，对刚开始或刚结束的任务会给出错误的数量。
#[tauri::command]
pub fn recording_active_count(state: State<'_, AppState>) -> usize {
    state.recording.active_count()
}

/// 停止所有录制、关停后台服务并退出。
///
/// 窗口关闭处理器阻止了关闭并把决定交给用户；这里是确认后的回答。
/// 停止过程使用 await 而非分离执行，以便在进程消失之前完成每个任务的
/// 媒体、弹幕伴生文件和元数据的收尾。
#[tauri::command(async)]
pub async fn app_confirm_exit(state: State<'_, AppState>) -> AppResult<()> {
    let state = state.inner();
    state.recording.stop_all_graceful().await;
    state.stream_proxy.stop();
    state.image_proxy.stop();
    state.lan_sync.stop();
    state.danmaku.disconnect();
    std::process::exit(0);
}
