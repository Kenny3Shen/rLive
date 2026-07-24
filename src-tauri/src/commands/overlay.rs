use std::sync::{Mutex, MutexGuard};

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::error::{AppError, AppResult};
use crate::player::PlayerBounds;

const OVERLAY_LABEL: &str = "danmaku-overlay";

/// Serialises overlay commands independently of the WebView event order.
///
/// Tauri invocations from a page are asynchronous.  A route cleanup can send
/// `overlay_close` before an already-issued `overlay_open` reaches Rust.  A
/// window lookup alone cannot distinguish that late open from a new request,
/// so it would recreate the transparent window after navigation.  The main
/// lifecycle manager assigns an increasing epoch to each visual surface; it
/// retains close tombstones and only lets the current epoch mutate the window.
pub struct OverlayLifecycle {
    inner: Mutex<OverlayLifecycleInner>,
}

#[derive(Default)]
struct OverlayLifecycleInner {
    /// Allocated by Rust so epochs remain monotonic even if the main WebView
    /// reloads (which would reset a JavaScript-only counter).
    next_epoch: u64,
    /// Any open at or below this epoch is known to have been closed.
    closed_through: u64,
    /// The epoch currently represented by `danmaku-overlay`, if any.
    active_epoch: Option<u64>,
    /// Whether the active surface is the separate fullscreen presentation.
    fullscreen: bool,
    /// Set as soon as the main native window starts closing.
    shutting_down: bool,
}

impl OverlayLifecycleInner {
    fn begin(&mut self) -> AppResult<u64> {
        if self.shutting_down {
            return Err(AppError::new(
                "overlay_shutting_down",
                "cannot create an overlay while the app is closing",
            ));
        }
        self.next_epoch = self.next_epoch.checked_add(1).ok_or_else(|| {
            AppError::new(
                "overlay_epoch_exhausted",
                "overlay lifecycle counter exhausted",
            )
        })?;
        Ok(self.next_epoch)
    }

    fn accepts_open(&self, epoch: u64) -> bool {
        !self.shutting_down
            && epoch > self.closed_through
            && self.active_epoch.is_none_or(|active| active <= epoch)
    }

    fn accepts_bounds(&self, epoch: u64) -> bool {
        !self.shutting_down && epoch > self.closed_through && self.active_epoch == Some(epoch)
    }

    fn close(&mut self, epoch: u64) -> bool {
        self.closed_through = self.closed_through.max(epoch);
        let should_hide = self.active_epoch.is_some_and(|active| active <= epoch);
        if should_hide {
            self.active_epoch = None;
            self.fullscreen = false;
        }
        should_hide
    }

    /// Route-level fallback when the JavaScript session token was lost (for
    /// example while a WebView was being reloaded or torn down).  This must
    /// tombstone every epoch allocated so far, otherwise an already queued
    /// `overlay_open` could recreate the window after navigation.
    fn force_close(&mut self) {
        self.closed_through = self.closed_through.max(self.next_epoch);
        self.active_epoch = None;
        self.fullscreen = false;
    }

    fn activate(&mut self, epoch: u64, fullscreen: bool) {
        self.active_epoch = Some(epoch);
        self.fullscreen = fullscreen;
    }
}

impl Default for OverlayLifecycle {
    fn default() -> Self {
        Self {
            inner: Mutex::new(OverlayLifecycleInner::default()),
        }
    }
}

impl OverlayLifecycle {
    fn lock(&self) -> MutexGuard<'_, OverlayLifecycleInner> {
        // A poisoned lifecycle must not make app shutdown unable to destroy a
        // native top-level window.  The fields are simple scalar state, so the
        // recovered guard is safe to use for the next operation.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn shutdown(&self) {
        let mut lifecycle = self.lock();
        lifecycle.shutting_down = true;
        lifecycle.active_epoch = None;
        lifecycle.fullscreen = false;
    }
}

fn inline_geometry(
    main: &WebviewWindow,
    bounds: PlayerBounds,
) -> AppResult<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let origin = main.inner_position().map_err(|e| {
        AppError::new(
            "overlay_position_error",
            format!("failed to read main window client position: {e}"),
        )
    })?;

    Ok((
        PhysicalPosition::new(origin.x + bounds.x, origin.y + bounds.y),
        PhysicalSize::new(bounds.width.max(16), bounds.height.max(16)),
    ))
}

fn fullscreen_geometry(
    main: &WebviewWindow,
) -> AppResult<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    if let Ok(Some(monitor)) = main.current_monitor() {
        return Ok((*monitor.position(), *monitor.size()));
    }

    let position = main.outer_position().map_err(|e| {
        AppError::new(
            "overlay_position_error",
            format!("failed to read main window position: {e}"),
        )
    })?;
    let size = main.inner_size().map_err(|e| {
        AppError::new(
            "overlay_size_error",
            format!("failed to read main window size: {e}"),
        )
    })?;
    Ok((position, size))
}

fn configure_overlay(
    overlay: &WebviewWindow,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    inline: bool,
) -> AppResult<()> {
    // Inline overlays are owned by the main window and must never be globally
    // topmost: otherwise a stale danmaku window can cover other applications.
    // Fullscreen mode is the only mode that needs topmost stacking.
    let fullscreen = !inline;
    overlay.set_fullscreen(false).map_err(|e| {
        AppError::new(
            "overlay_config_error",
            format!("failed to leave fullscreen: {e}"),
        )
    })?;
    overlay.set_position(position).map_err(|e| {
        AppError::new(
            "overlay_config_error",
            format!("failed to position overlay: {e}"),
        )
    })?;
    overlay.set_size(size).map_err(|e| {
        AppError::new(
            "overlay_config_error",
            format!("failed to size overlay: {e}"),
        )
    })?;
    overlay.set_ignore_cursor_events(inline).map_err(|e| {
        AppError::new(
            "overlay_config_error",
            format!("failed to set overlay mouse passthrough: {e}"),
        )
    })?;
    overlay.set_focusable(fullscreen).map_err(|e| {
        AppError::new(
            "overlay_config_error",
            format!("failed to set overlay focusability: {e}"),
        )
    })?;
    overlay.set_always_on_top(fullscreen).map_err(|e| {
        AppError::new(
            "overlay_config_error",
            format!("failed to set overlay stacking: {e}"),
        )
    })?;
    overlay.show().map_err(|e| {
        AppError::new(
            "overlay_config_error",
            format!("failed to show overlay: {e}"),
        )
    })?;
    if fullscreen {
        overlay.set_focus().map_err(|e| {
            AppError::new(
                "overlay_config_error",
                format!("failed to focus overlay: {e}"),
            )
        })?;
    }
    Ok(())
}

/// Create or update the transparent danmaku overlay.
///
/// With `bounds`, it is a click-through window precisely over the embedded
/// video host. Without `bounds`, it covers the current monitor for fullscreen
/// playback and exposes the fullscreen controls.
#[tauri::command]
pub fn overlay_begin(lifecycle: State<'_, OverlayLifecycle>) -> AppResult<u64> {
    lifecycle.lock().begin()
}

#[tauri::command]
pub fn overlay_open(
    app: AppHandle,
    lifecycle: State<'_, OverlayLifecycle>,
    epoch: u64,
    bounds: Option<PlayerBounds>,
) -> AppResult<()> {
    // Keep the lifecycle lock through the native window operations.  Merely
    // marking an epoch first is insufficient: a close could otherwise run
    // between the mark and `build()`, then a late build would resurrect it.
    let mut lifecycle = lifecycle.lock();
    if !lifecycle.accepts_open(epoch) {
        return Ok(());
    }

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::new("overlay_no_main", "main window missing"))?;
    let inline = bounds.is_some();
    let (position, size) = match bounds {
        Some(bounds) => inline_geometry(&main, bounds)?,
        None => fullscreen_geometry(&main)?,
    };

    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        configure_overlay(&existing, position, size, inline)?;
        lifecycle.activate(epoch, !inline);
        return Ok(());
    }

    let scale = main.scale_factor().unwrap_or(1.0).max(1.0);
    // On Windows, `parent` creates an owned window. Windows then keeps it
    // above rLive only (not above unrelated applications), hides it with the
    // owner and destroys it automatically when the owner exits.
    let builder = WebviewWindowBuilder::new(
        &app,
        OVERLAY_LABEL,
        WebviewUrl::App("index.html?overlay=1".into()),
    )
    .parent(&main)
    .map_err(|e| AppError::new("overlay_owner_error", format!("failed to own overlay: {e}")))?
    .title("rLive Danmaku")
    .transparent(true)
    .decorations(false)
    .skip_taskbar(true)
    .resizable(false)
    .focused(!inline)
    .visible(false)
    .inner_size(size.width as f64 / scale, size.height as f64 / scale)
    .position(position.x as f64 / scale, position.y as f64 / scale);

    let overlay = builder.build().map_err(|e| {
        AppError::new(
            "overlay_create_error",
            format!("failed to create danmaku overlay: {e}"),
        )
    })?;
    if let Err(error) = configure_overlay(&overlay, position, size, inline) {
        let _ = overlay.hide();
        let _ = overlay.destroy();
        return Err(error);
    }
    lifecycle.activate(epoch, !inline);

    Ok(())
}

/// Keep an existing inline overlay in lockstep with the embedded player host.
/// Do not create a window here: only a successful player open should start a
/// visual danmaku surface.
#[tauri::command]
pub fn overlay_set_bounds(
    app: AppHandle,
    lifecycle: State<'_, OverlayLifecycle>,
    epoch: u64,
    bounds: PlayerBounds,
) -> AppResult<()> {
    let lifecycle = lifecycle.lock();
    if !lifecycle.accepts_bounds(epoch) {
        return Ok(());
    }

    let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(());
    };
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::new("overlay_no_main", "main window missing"))?;
    let (position, size) = inline_geometry(&main, bounds)?;
    configure_overlay(&overlay, position, size, true)?;
    Ok(())
}

/// Destroy the overlay synchronously. This is also called from the native app
/// lifecycle because closing the main window must not leave another WebView
/// alive to keep the process (or a top-level window) around.
pub fn destroy_overlay(app: &AppHandle) {
    if let Some(lifecycle) = app.try_state::<OverlayLifecycle>() {
        lifecycle.inner().shutdown();
    }
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        // Hide immediately, then force-destroy. `close` emits a request event
        // and can be delayed or intercepted by the webview.
        let _ = overlay.hide();
        let _ = overlay.destroy();
    }
}

/// A fullscreen companion needs topmost stacking to appear over mpv's separate
/// fullscreen window.  Hide it as soon as it loses focus, so it cannot remain
/// above another Windows application after Alt+Tab.  The owned main window
/// restores it when rLive is focused again.
pub fn handle_overlay_focus(app: &AppHandle, label: &str, focused: bool) {
    let Some(lifecycle) = app.try_state::<OverlayLifecycle>() else {
        return;
    };
    let lifecycle = lifecycle.lock();
    if lifecycle.shutting_down || !lifecycle.fullscreen || lifecycle.active_epoch.is_none() {
        return;
    }

    if label == OVERLAY_LABEL && !focused {
        if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = overlay.hide();
        }
    } else if label == "main" && focused {
        if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = overlay.show();
        }
    }
}

#[tauri::command]
pub fn overlay_close(
    app: AppHandle,
    lifecycle: State<'_, OverlayLifecycle>,
    epoch: Option<u64>,
) -> AppResult<()> {
    // A delayed cleanup for an old room must never destroy an overlay that a
    // newer room/fullscreen transition has already created.
    let mut lifecycle = lifecycle.lock();
    let should_hide = match epoch {
        Some(epoch) => lifecycle.close(epoch),
        // This path is only used after navigating out of `/room/*`.  It is
        // intentionally broad: there can no longer be a legitimate overlay
        // to preserve, while an untracked native window would otherwise stay
        // above the next page.
        None => {
            lifecycle.force_close();
            true
        }
    };
    if should_hide {
        if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
            // Park the companion so it cannot remain visible as an independent
            // "ghost" window after leaving a room. Keep the label (no destroy)
            // to avoid Tauri recreate races; tombstones block late opens.
            let _ = overlay.set_always_on_top(false);
            let _ = overlay.set_ignore_cursor_events(true);
            let _ = overlay.set_focusable(false);
            // Move off-screen and shrink so even a failed hide cannot leave a
            // visible floating surface on the desktop.
            let _ = overlay.set_position(PhysicalPosition::new(-32_000, -32_000));
            let _ = overlay.set_size(PhysicalSize::new(1, 1));
            let _ = overlay.hide();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::OverlayLifecycleInner;

    #[test]
    fn close_tombstone_blocks_a_late_open() {
        let mut lifecycle = OverlayLifecycleInner::default();
        assert!(lifecycle.accepts_open(7));
        lifecycle.activate(7, false);
        assert!(lifecycle.close(7));
        assert!(!lifecycle.accepts_open(7));
    }

    #[test]
    fn old_close_does_not_target_a_newer_surface() {
        let mut lifecycle = OverlayLifecycleInner {
            active_epoch: Some(12),
            ..Default::default()
        };
        let closing_epoch = 11;
        assert!(!lifecycle.close(closing_epoch));
        assert_eq!(lifecycle.active_epoch, Some(12));
    }

    #[test]
    fn old_resize_cannot_reshow_a_closed_surface() {
        let mut lifecycle = OverlayLifecycleInner::default();
        lifecycle.activate(4, false);
        assert!(lifecycle.accepts_bounds(4));
        lifecycle.close(4);
        assert!(!lifecycle.accepts_bounds(4));
    }

    #[test]
    fn force_close_tombstones_every_allocated_surface() {
        let mut lifecycle = OverlayLifecycleInner::default();
        let first = lifecycle.begin().unwrap();
        let second = lifecycle.begin().unwrap();
        lifecycle.activate(second, false);
        lifecycle.force_close();

        assert!(!lifecycle.accepts_open(first));
        assert!(!lifecycle.accepts_open(second));
        assert!(lifecycle.active_epoch.is_none());
    }

    #[test]
    fn epochs_are_allocated_by_native_state() {
        let mut lifecycle = OverlayLifecycleInner::default();
        assert_eq!(lifecycle.begin().unwrap(), 1);
        assert_eq!(lifecycle.begin().unwrap(), 2);
    }
}
