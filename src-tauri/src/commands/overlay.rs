use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};

const OVERLAY_LABEL: &str = "danmaku-overlay";

/// Create or focus the transparent fullscreen danmaku overlay window.
#[tauri::command]
pub async fn overlay_open(app: AppHandle) -> AppResult<()> {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = existing.set_focus();
        let _ = existing.show();
        return Ok(());
    }

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::new("overlay_no_main", "main window missing"))?;

    // Match the monitor that hosts the main window when possible.
    let mut builder = WebviewWindowBuilder::new(
        &app,
        OVERLAY_LABEL,
        WebviewUrl::App("index.html?overlay=1".into()),
    )
    .title("rLive Danmaku")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(true)
    .visible(true);

    if let Ok(Some(monitor)) = main.current_monitor() {
        let size = monitor.size();
        let pos = monitor.position();
        builder = builder
            .inner_size(size.width as f64, size.height as f64)
            .position(pos.x as f64, pos.y as f64);
    } else {
        builder = builder.fullscreen(true);
    }

    builder.build().map_err(|e| {
        AppError::new(
            "overlay_create_error",
            format!("failed to create danmaku overlay: {e}"),
        )
    })?;

    Ok(())
}

#[tauri::command]
pub fn overlay_close(app: AppHandle) -> AppResult<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.close();
    }
    Ok(())
}
