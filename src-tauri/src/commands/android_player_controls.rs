//! 把播放器边缘手势转发给 Android 的 `RlivePlayerControlsPlugin`。
//!
//! Android 的媒体音量刻意交由原生 `AudioManager` 桥接处理，
//! 使移动端播放器遵循设备的媒体音量语义。
//!
//! `plugin:<name>|<command>` 形式的 invoke 由 *Rust* 插件自己的 invoke handler
//! 应答，绝不会由 Kotlin 的 `@Command` 方法应答，因此 webview 无法直接触达
//! 移动端插件。Kotlin 只能通过 `register_android_plugin` 返回的 `PluginHandle`
//! 触达，而这些应用命令正是对它的封装。把它们注册在应用自己的
//! `generate_handler!` 中，也能让它们继续沿用现有的 `core:default` 能力，
//! 而不需要另建一套插件权限集合。
//!
//! 桌面端与浏览器构建编译文件末尾那些直接拒绝的 stub，
//! 并继续使用现有的 Web 播放器控制。

#[cfg(target_os = "android")]
mod android {
    use crate::error::{AppError, AppResult};
    use serde_json::{Value, json};
    use tauri::State;
    use tauri::plugin::PluginHandle;

    /// 受管理的包装类型，使命令能触达已注册的 Kotlin 插件。
    pub struct AndroidPlayerControls(pub PluginHandle<tauri::Wry>);

    /// Kotlin 命令解析的是普通 JSON 对象（`{value}`、
    /// `{mediaVolume, brightness}`、`{orientation}`），因此入参和应答都原样透传。
    /// 这里使用 `run_mobile_plugin_async` 而非阻塞版本，是因为 JNI 调用会被派发回
    /// Activity：在那里阻塞 invoke 线程可能造成死锁。
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
    pub async fn android_player_controls_set_media_volume(
        controls: State<'_, AndroidPlayerControls>,
        value: f64,
    ) -> AppResult<Value> {
        run(controls, "setMediaVolume", json!({ "value": value })).await
    }

    #[tauri::command]
    pub async fn android_player_controls_set_brightness(
        controls: State<'_, AndroidPlayerControls>,
        value: f64,
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

    /// 为页面内全屏播放器隐藏或恢复系统栏。
    ///
    /// Android 全屏刻意避开 HTML Fullscreen API —— 具体原因见 Kotlin 的
    /// `setImmersive`，那里说明了 custom-view 表面交接才是闪烁根源 ——
    /// 因此沉浸式系统栏的请求与页面把播放区域布局为固定层这两件事分开进行。
    #[tauri::command]
    pub async fn android_player_controls_set_immersive(
        controls: State<'_, AndroidPlayerControls>,
        immersive: bool,
    ) -> AppResult<Value> {
        run(controls, "setImmersive", json!({ "immersive": immersive })).await
    }
}

#[cfg(target_os = "android")]
pub use android::{
    AndroidPlayerControls, android_player_controls_get_state,
    android_player_controls_reset_brightness, android_player_controls_set_brightness,
    android_player_controls_set_immersive, android_player_controls_set_media_volume,
    android_player_controls_set_orientation,
};

#[cfg(not(target_os = "android"))]
mod fallback {
    use crate::error::{AppError, AppResult};
    use serde_json::Value;

    /// 前端会先做 Android 判断再调用这些命令，所以桌面端走到这里说明有 bug，
    /// 而不是用户可见路径；这里明确报错，
    /// 而不是假装原生控制已经成功。
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
    pub async fn android_player_controls_set_media_volume(_value: f64) -> AppResult<Value> {
        Err(unsupported())
    }

    #[tauri::command]
    pub async fn android_player_controls_set_brightness(_value: f64) -> AppResult<Value> {
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

    #[tauri::command]
    pub async fn android_player_controls_set_immersive(_immersive: bool) -> AppResult<Value> {
        Err(unsupported())
    }
}

#[cfg(not(target_os = "android"))]
pub use fallback::{
    android_player_controls_get_state, android_player_controls_reset_brightness,
    android_player_controls_set_brightness, android_player_controls_set_immersive,
    android_player_controls_set_media_volume, android_player_controls_set_orientation,
};
