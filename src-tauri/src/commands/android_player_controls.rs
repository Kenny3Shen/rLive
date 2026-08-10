//! Forwards the player brightness gesture to the Android `RlivePlayerControlsPlugin`.
//!
//! Volume is intentionally absent: it is applied app-locally on `<video>` by
//! the web player, never to the device-wide `STREAM_MUSIC`.
//!
//! A `plugin:<name>|<command>` invoke is answered by the *Rust* plugin's own
//! invoke handler, never by the Kotlin `@Command` methods, so the webview
//! cannot reach a mobile plugin directly. Kotlin is reachable only through the
//! `PluginHandle` returned by `register_android_plugin`, which is what these
//! app commands wrap. Registering them in the app's own `generate_handler!`
//! also keeps them under the existing `core:default` capability instead of
//! needing a separate plugin permission set.
//!
//! Desktop and browser builds compile the rejecting stubs at the bottom and
//! keep the existing web player controls.

#[cfg(target_os = "android")]
mod android {
    use crate::error::{AppError, AppResult};
    use serde_json::{Value, json};
    use tauri::State;
    use tauri::plugin::PluginHandle;

    /// Managed wrapper so commands can reach the registered Kotlin plugin.
    pub struct AndroidPlayerControls(pub PluginHandle<tauri::Wry>);

    /// The Kotlin commands resolve plain JSON objects (`{value}`,
    /// `{brightness}`, `{orientation}`), so the payload and the
    /// reply are passed through untouched. `run_mobile_plugin_async` is used
    /// rather than the blocking variant because the JNI call is dispatched back
    /// through the Activity: blocking the invoke thread there can deadlock.
    async fn run(
        controls: State<'_, AndroidPlayerControls>,
        command: &'static str,
        payload: Value,
    ) -> AppResult<Value> {
        controls
            .0
            .run_mobile_plugin_async::<Value>(command, payload)
            .await
            .map_err(|error| {
                tracing::warn!(command, %error, "Android 播放器控制命令失败");
                AppError::new(
                    "android_player_controls_error",
                    format!("{command}: {error}"),
                )
            })
    }

    #[tauri::command]
    pub async fn android_player_controls_get_state(
        controls: State<'_, AndroidPlayerControls>,
    ) -> AppResult<Value> {
        run(controls, "getState", json!({})).await
    }

    #[tauri::command]
    pub async fn android_player_controls_set_brightness(
        controls: State<'_, AndroidPlayerControls>,
        value: i32,
    ) -> AppResult<Value> {
        run(controls, "setBrightness", json!({ "value": value })).await
    }

    #[tauri::command]
    pub async fn android_player_controls_reset_brightness(
        controls: State<'_, AndroidPlayerControls>,
    ) -> AppResult<Value> {
        run(controls, "resetBrightness", json!({})).await
    }

    #[tauri::command]
    pub async fn android_player_controls_set_orientation(
        controls: State<'_, AndroidPlayerControls>,
        orientation: String,
    ) -> AppResult<Value> {
        run(
            controls,
            "setPlayerOrientation",
            json!({ "orientation": orientation }),
        )
        .await
    }
}

#[cfg(target_os = "android")]
pub use android::{
    AndroidPlayerControls, android_player_controls_get_state,
    android_player_controls_reset_brightness, android_player_controls_set_brightness,
    android_player_controls_set_orientation,
};

#[cfg(not(target_os = "android"))]
mod fallback {
    use crate::error::{AppError, AppResult};
    use serde_json::Value;

    /// The frontend guards these calls behind an Android check, so a desktop
    /// hit means a bug rather than a user-visible path; report it explicitly
    /// instead of pretending the native controls succeeded.
    fn unsupported() -> AppError {
        AppError::new(
            "android_player_controls_unsupported",
            "播放器系统控制仅在 Android 客户端可用",
        )
    }

    #[tauri::command]
    pub async fn android_player_controls_get_state() -> AppResult<Value> {
        Err(unsupported())
    }

    #[tauri::command]
    pub async fn android_player_controls_set_brightness(_value: i32) -> AppResult<Value> {
        Err(unsupported())
    }

    #[tauri::command]
    pub async fn android_player_controls_reset_brightness() -> AppResult<Value> {
        Err(unsupported())
    }

    #[tauri::command]
    pub async fn android_player_controls_set_orientation(_orientation: String) -> AppResult<Value> {
        Err(unsupported())
    }
}

#[cfg(not(target_os = "android"))]
pub use fallback::{
    android_player_controls_get_state, android_player_controls_reset_brightness,
    android_player_controls_set_brightness, android_player_controls_set_orientation,
};
