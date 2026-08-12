//! Maps `POST /api/invoke/<command>` onto the existing `#[tauri::command]`
//! functions.
//!
//! Every arm calls the same function the WebView's `invoke` bridge calls, with
//! arguments deserialized from the request's JSON object using the camelCase
//! keys the frontend already sends. Nothing here reimplements site, database or
//! playback behaviour; adding a command to this table is the only step needed
//! to make it reachable from a browser.
//!
//! Commands that require a native host capability are deliberately absent:
//! - `profile_export` / `profile_import` take an OS file path from the native
//!   dialog plugin, which a browser tab cannot produce.
//! - the ASR commands stream local microphone PCM over IPC and are desktop-only
//!   in the UI as well.
//! A browser calling one of those receives `web_bridge_unsupported_command`
//! rather than a partial result.

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::commands;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Pulls one named argument out of the request body, applying serde's own
/// defaults for a missing optional value.
fn arg<T: serde::de::DeserializeOwned>(args: &Value, name: &str) -> AppResult<T> {
    let raw = args.get(name).cloned().unwrap_or(Value::Null);
    serde_json::from_value(raw).map_err(|error| {
        AppError::new(
            "web_bridge_bad_argument",
            format!("参数 {name} 无效: {error}"),
        )
    })
}

fn ok<T: serde::Serialize>(value: T) -> AppResult<Value> {
    serde_json::to_value(value).map_err(|error| {
        AppError::new(
            "web_bridge_encode_error",
            format!("命令结果序列化失败: {error}"),
        )
    })
}

/// Dispatches one command by name. `args` is the JSON object the browser sent.
pub async fn invoke(app: &AppHandle, command: &str, args: &Value) -> AppResult<Value> {
    let state = app.state::<AppState>();

    match command {
        // ---- settings ----
        "settings_get" => ok(commands::settings::settings_get(state.clone())?),
        "settings_set" => ok(commands::settings::settings_set(
            state.clone(),
            arg(args, "settings")?,
        )?),

        // ---- accounts ----
        "account_get_cookie" => ok(commands::account::account_get_cookie(
            state.clone(),
            arg(args, "siteId")?,
        )?),
        "account_set_cookie" => ok(commands::account::account_set_cookie(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "cookie")?,
        )?),
        "account_clear_cookie" => ok(commands::account::account_clear_cookie(
            state.clone(),
            arg(args, "siteId")?,
        )?),
        "account_get_profile" => ok(commands::account::account_get_profile(
            state.clone(),
            arg(args, "siteId")?,
        )
        .await?),
        "account_qr_login_start" => ok(commands::account::account_qr_login_start(
            state.clone(),
            arg(args, "siteId")?,
        )
        .await?),
        "account_qr_login_poll" => ok(commands::account::account_qr_login_poll(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "qrKey")?,
        )
        .await?),

        // ---- sites / browsing ----
        "site_list" => ok(commands::site::site_list()),
        "site_get_categories" => ok(commands::site::site_get_categories(
            state.clone(),
            arg(args, "siteId")?,
        )
        .await?),
        "site_get_recommend" => ok(commands::site::site_get_recommend(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "page")?,
        )
        .await?),
        "site_get_category_rooms" => ok(commands::site::site_get_category_rooms(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "category")?,
            arg(args, "page")?,
        )
        .await?),
        "site_search_rooms" => ok(commands::site::site_search_rooms(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "keyword")?,
            arg(args, "page")?,
        )
        .await?),
        "site_get_room_detail" => ok(commands::site::site_get_room_detail(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "roomId")?,
        )
        .await?),
        "site_get_play_qualities" => ok(commands::site::site_get_play_qualities(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "detail")?,
        )
        .await?),
        "site_get_play_urls" => ok(commands::site::site_get_play_urls(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "detail")?,
            arg(args, "quality")?,
        )
        .await?),

        // ---- history ----
        "history_list" => ok(commands::history::history_list(
            state.clone(),
            arg(args, "siteId")?,
        )?),
        "history_add" => ok(commands::history::history_add(
            state.clone(),
            arg(args, "item")?,
        )?),
        "history_clear" => ok(commands::history::history_clear(state.clone())?),
        "history_remove" => ok(commands::history::history_remove(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "roomId")?,
        )?),

        // ---- follows / tags ----
        "follow_list" => ok(commands::follow::follow_list(state.clone())?),
        "follow_add" => ok(commands::follow::follow_add(
            state.clone(),
            arg(args, "user")?,
        )?),
        "follow_remove" => ok(commands::follow::follow_remove(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "roomId")?,
        )?),
        "follow_set_tags" => ok(commands::follow::follow_set_tags(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "roomId")?,
            arg(args, "tagIds")?,
        )?),
        "follow_refresh" => ok(commands::follow::follow_refresh(state.clone()).await?),
        "tag_list" => ok(commands::follow::tag_list(state.clone())?),
        "tag_upsert" => ok(commands::follow::tag_upsert(
            state.clone(),
            arg(args, "name")?,
            arg(args, "id")?,
        )?),
        "tag_remove" => ok(commands::follow::tag_remove(
            state.clone(),
            arg(args, "id")?,
        )?),

        // ---- IPTV ----
        "iptv_load_playlist" => ok(commands::iptv::iptv_load_playlist(
            state.clone(),
            arg(args, "sourceUrl")?,
        )
        .await?),
        "iptv_check_channels" => ok(commands::iptv::iptv_check_channels(
            state.clone(),
            arg(args, "checks")?,
        )
        .await?),
        "iptv_favorite_list" => ok(commands::iptv::iptv_favorite_list(
            state.clone(),
            arg(args, "sourceId")?,
        )?),
        "iptv_favorite_add" => ok(commands::iptv::iptv_favorite_add(
            state.clone(),
            arg(args, "favorite")?,
        )?),
        "iptv_favorite_remove" => ok(commands::iptv::iptv_favorite_remove(
            state.clone(),
            arg(args, "sourceId")?,
            arg(args, "channelUrl")?,
        )?),
        "iptv_favorite_group_list" => {
            ok(commands::iptv::iptv_favorite_group_list(state.clone())?)
        }
        "iptv_favorite_group_upsert" => ok(commands::iptv::iptv_favorite_group_upsert(
            state.clone(),
            arg(args, "name")?,
            arg(args, "id")?,
        )?),
        "iptv_favorite_group_remove" => ok(commands::iptv::iptv_favorite_group_remove(
            state.clone(),
            arg(args, "id")?,
        )?),
        "iptv_favorite_set_group" => ok(commands::iptv::iptv_favorite_set_group(
            state.clone(),
            arg(args, "sourceId")?,
            arg(args, "channelUrl")?,
            arg(args, "groupId")?,
        )?),

        // ---- playback proxies ----
        "stream_proxy_start" => ok(commands::stream_proxy::stream_proxy_start(
            state.clone(),
            arg(args, "url")?,
            arg(args, "headers")?,
            arg(args, "sessionId")?,
            arg(args, "hls")?,
            arg(args, "twitchAdRecovery")?,
        )
        .await?),
        "stream_proxy_stop" => ok(commands::stream_proxy::stream_proxy_stop(
            state.clone(),
            arg(args, "sessionId")?,
        )?),
        "stream_proxy_probe_sources" => ok(commands::stream_proxy::stream_proxy_probe_sources(
            state.clone(),
            arg(args, "sources")?,
        )
        .await?),
        "stream_proxy_telemetry" => ok(commands::stream_proxy::stream_proxy_telemetry(
            state.clone(),
            arg(args, "sessionId")?,
        )?),
        "image_proxy_url" => ok(commands::image_proxy::image_proxy_url(state.clone()).await?),

        // ---- danmaku ----
        "danmaku_connect" => ok(commands::danmaku::danmaku_connect(
            app.clone(),
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "roomId")?,
            arg(args, "connectionEpoch")?,
        )
        .await?),
        "danmaku_disconnect" => ok(commands::danmaku::danmaku_disconnect(
            state.clone(),
            arg(args, "connectionEpoch")?,
        )?),
        "bilibili_danmaku_send_status" => ok(commands::danmaku::bilibili_danmaku_send_status(
            state.clone(),
        )?),
        "bilibili_danmaku_send" => ok(commands::danmaku::bilibili_danmaku_send(
            state.clone(),
            arg(args, "roomId")?,
            arg(args, "message")?,
            arg(args, "roomTitle")?,
            arg(args, "roomUserName")?,
        )
        .await?),
        "douyu_danmaku_send_status" => {
            ok(commands::danmaku::douyu_danmaku_send_status(state.clone())?)
        }
        "douyu_danmaku_send" => ok(commands::danmaku::douyu_danmaku_send(
            state.clone(),
            arg(args, "roomId")?,
            arg(args, "message")?,
            arg(args, "roomTitle")?,
            arg(args, "roomUserName")?,
        )
        .await?),
        "huya_danmaku_send_status" => {
            ok(commands::danmaku::huya_danmaku_send_status(state.clone())?)
        }
        "huya_danmaku_send" => ok(commands::danmaku::huya_danmaku_send(
            state.clone(),
            arg(args, "roomId")?,
            arg(args, "message")?,
            arg(args, "roomTitle")?,
            arg(args, "roomUserName")?,
        )
        .await?),

        // ---- danmaku favorites / send history ----
        "danmaku_favorite_list" => ok(commands::danmaku_favorite::danmaku_favorite_list(
            state.clone(),
            arg(args, "siteId")?,
        )?),
        "danmaku_favorite_add" => ok(commands::danmaku_favorite::danmaku_favorite_add(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "content")?,
        )?),
        "danmaku_favorite_remove" => ok(commands::danmaku_favorite::danmaku_favorite_remove(
            state.clone(),
            arg(args, "siteId")?,
            arg(args, "content")?,
        )?),
        "danmaku_send_history_list" => {
            ok(commands::danmaku_send_history::danmaku_send_history_list(
                state.clone(),
                arg(args, "siteId")?,
            )?)
        }
        "danmaku_send_history_list_all" => ok(
            commands::danmaku_send_history::danmaku_send_history_list_all(state.clone())?,
        ),
        "danmaku_send_history_clear" => {
            ok(commands::danmaku_send_history::danmaku_send_history_clear(
                state.clone(),
                arg(args, "siteId")?,
            )?)
        }
        "danmaku_send_history_clear_all" => ok(
            commands::danmaku_send_history::danmaku_send_history_clear_all(state.clone())?,
        ),

        // ---- LAN profile sync ----
        "lan_sync_start" => ok(commands::lan_sync::lan_sync_start(state.clone()).await?),
        "lan_sync_status" => ok(commands::lan_sync::lan_sync_status(state.clone())?),
        "lan_sync_stop" => {
            commands::lan_sync::lan_sync_stop(state.clone());
            Ok(json!(null))
        }
        "lan_sync_receive" => ok(commands::lan_sync::lan_sync_receive(
            state.clone(),
            arg(args, "address")?,
            arg(args, "code")?,
        )
        .await?),

        // ---- the bridge itself ----
        // A browser may read the status but not start or stop the listener it is
        // being served from: that decision stays with the native window.
        "web_bridge_status" => ok(commands::web_bridge::web_bridge_status(state.clone())),

        _ => Err(AppError::new(
            "web_bridge_unsupported_command",
            format!("Web 平台不支持命令 {command}"),
        )),
    }
}

/// Commands a browser cannot serve, kept as an explicit list so the frontend
/// can hide the corresponding controls instead of failing at call time.
pub const NATIVE_ONLY_COMMANDS: &[&str] = &[
    "profile_export",
    "profile_import",
    "web_bridge_start",
    "web_bridge_stop",
    "asr_get_status",
    "asr_enable",
    "asr_disable",
    "asr_reset_stream",
    "asr_transcribe",
    "android_player_controls_get_state",
    "android_player_controls_set_brightness",
    "android_player_controls_reset_brightness",
    "android_player_controls_set_media_volume",
    "android_player_controls_set_orientation",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_optional_arguments_use_their_serde_default() {
        let args = json!({});
        let site: Option<String> = arg(&args, "siteId").expect("null decodes to None");
        assert!(site.is_none());
    }

    #[test]
    fn a_wrong_argument_type_is_reported_by_name() {
        let args = json!({"page": "not-a-number"});
        let error = arg::<u32>(&args, "page").expect_err("string is not a u32");
        assert_eq!(error.code, "web_bridge_bad_argument");
        assert!(error.message.contains("page"));
    }

    /// Command names taken from the `match` arms of `invoke`, read out of this
    /// file's own source.  The arms are not enumerable at runtime, and a naming
    /// heuristic would only prove that the lists *look* disjoint, so the source
    /// text is the one honest way to compare them.
    fn dispatchable_commands() -> Vec<String> {
        include_str!("dispatch.rs")
            .lines()
            .map(str::trim)
            // An arm starts a line as `"name" => ...`; the `=>` is what separates
            // it from the string literals inside an arm's body.
            .filter_map(|line| {
                let rest = line.strip_prefix('"')?;
                let (name, tail) = rest.split_once('"')?;
                tail.trim_start().starts_with("=>").then(|| name.to_string())
            })
            .collect()
    }

    #[test]
    fn native_only_commands_are_not_dispatchable() {
        // The dispatch table and this list must stay disjoint, otherwise the
        // frontend would hide a control that actually works, or leave one visible
        // that always fails.
        let dispatchable = dispatchable_commands();
        assert!(
            dispatchable.len() > 50,
            "source scan found only {} arms, so the parser is broken rather than \
             the invariant holding vacuously",
            dispatchable.len()
        );
        for command in NATIVE_ONLY_COMMANDS {
            assert!(
                !dispatchable.iter().any(|arm| arm == command),
                "{command} is both dispatchable and marked native-only"
            );
        }
    }

    #[test]
    fn web_bridge_status_is_readable_but_start_and_stop_are_not() {
        // The precise split the security boundary depends on: a browser tab can
        // see whether the bridge is exposed, but cannot open LAN access or close
        // the transport that is serving it.
        let dispatchable = dispatchable_commands();
        assert!(dispatchable.iter().any(|arm| arm == "web_bridge_status"));
        assert!(NATIVE_ONLY_COMMANDS.contains(&"web_bridge_start"));
        assert!(NATIVE_ONLY_COMMANDS.contains(&"web_bridge_stop"));
    }
}
