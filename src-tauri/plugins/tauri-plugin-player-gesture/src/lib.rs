//! Native Android controls used by the live-player's left/right edge gestures.
//!
//! The frontend calls this only from the Android Tauri shell. Keeping it as a
//! constrained mobile plugin means remote web content cannot reach the native
//! bridge without an explicit Tauri capability grant.

use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

#[cfg(target_os = "android")]
const ANDROID_PLUGIN_IDENTIFIER: &str = "app.tauri.player_gesture";

/// Registers the Android implementation. Other platforms retain the normal
/// web-player fallback and intentionally receive no native controls.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("player-gesture")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                api.register_android_plugin(ANDROID_PLUGIN_IDENTIFIER, "PlayerGesturePlugin")?;
            }
            Ok(())
        })
        .build()
}
