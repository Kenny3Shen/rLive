use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;

use crate::db::follow::{self, FollowRecord, TagRecord};
use crate::db::history::{self, HistoryRecord};
use crate::db::iptv_favorite::{self, IptvFavoriteGroupRecord, IptvFavoriteRecord};
use crate::db::schema::map_db_err;
use crate::error::{AppError, AppResult};
use crate::models::settings::AppSettings;
use crate::settings;
use rusqlite::Connection;

const PROFILE_VERSION: u32 = 2;
/// 便携包不携带的本机专属设置。
///
/// 这份名单无法用派生宏表达：`AppSettings` 在 `settings_kv` 路径上对它们是
/// 必填的（缺字段说明记录不是当前 schema），而在配置包里必须允许缺失。
/// 同一个结构体两种线格式，因此导入时由 `fill_local_only_settings` 回填、
/// 导出时由 `portable_profile_value` 剔除。
const LOCAL_ONLY_PROFILE_SETTINGS_FIELDS: &[&str] = &[
    "danmaku_send_enabled",
    "asr_enabled",
    "asr_provider",
    "asr_vad_enabled",
    "asr_punctuation_enabled",
    "asr_speaker_diarization_enabled",
    "asr_hotwords",
    "asr_window_seconds",
    "asr_translation_enabled",
    "asr_translation_from",
    "asr_translation_to",
    "iptv_custom_m3u_url",
];

/// 配置包只应包含结构化的设置与历史，绝不应携带媒体或模型数据。
/// 在 JSON 解析之前先限制读取大小，
/// 使畸形的 Android content URI（或误选的视频文件）
/// 无法让导入进行无界分配。
pub(crate) const MAX_PROFILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfilePackage {
    pub version: u32,
    pub exported_at: i64,
    pub settings: AppSettings,
    pub follows: Vec<FollowRecord>,
    pub iptv_favorites: Vec<IptvFavoriteRecord>,
    pub iptv_favorite_groups: Vec<IptvFavoriteGroupRecord>,
    pub tags: Vec<TagRecord>,
    pub history: Vec<HistoryRecord>,
    pub danmaku_shield_words: Vec<String>,
    /// 顶层副本；`settings.danmaku_blocked_users` 与它合并导入。
    #[serde(default)]
    pub danmaku_blocked_users: Vec<String>,
}

impl ProfilePackage {
    #[cfg(test)]
    fn sample() -> Self {
        Self {
            version: PROFILE_VERSION,
            exported_at: 0,
            settings: AppSettings::default(),
            follows: vec![],
            iptv_favorites: vec![],
            iptv_favorite_groups: vec![],
            tags: vec![],
            history: vec![],
            danmaku_shield_words: vec![],
            danmaku_blocked_users: vec![],
        }
    }
}

/// 这些控件刻意不随配置离开当前设备。
///
/// 弹幕发送开关是对一次写入操作的明确授权，而自定义 M3U 地址可能标识私有
/// 播放列表或携带访问 token。
/// 导入的配置不得替用户决定其中任何一项。
fn clear_local_only_settings(settings: &mut AppSettings) {
    settings.danmaku_send_enabled = false;
    settings.asr_enabled = false;
    settings.asr_provider = "auto".into();
    settings.asr_vad_enabled = true;
    settings.asr_punctuation_enabled = true;
    settings.asr_speaker_diarization_enabled = false;
    settings.asr_hotwords.clear();
    settings.asr_window_seconds = Default::default();
    settings.asr_translation_enabled = false;
    settings.asr_translation_from = "auto".into();
    settings.asr_translation_to = "zh-CN".into();
    settings.iptv_custom_m3u_url = None;
}

/// 把配置包转换为便携的磁盘表示。
///
/// 除了 [`export_package`]，这里也要保留防御性剥离：
/// 自行构造 `ProfilePackage` 的 [`encode_package`] 调用方，
/// 不应意外导出仅限本地的控件。
fn portable_profile_value(package: &ProfilePackage) -> AppResult<serde_json::Value> {
    let mut portable = package.clone();
    clear_local_only_settings(&mut portable.settings);
    portable
        .iptv_favorites
        .retain(|favorite| is_portable_iptv_source(&favorite.source_id));

    let mut value = serde_json::to_value(portable)
        .map_err(|e| AppError::new("profile_encode_error", format!("serialize: {e}")))?;
    if let Some(settings) = value
        .get_mut("settings")
        .and_then(|value| value.as_object_mut())
    {
        // 省略而非序列化看似安全的默认值，
        // 使将来导入逻辑的变化不会把这些仅限本机的选择误当成便携数据。
        for field in LOCAL_ONLY_PROFILE_SETTINGS_FIELDS {
            settings.remove(*field);
        }
    }
    Ok(value)
}

fn is_portable_iptv_source(source_id: &str) -> bool {
    matches!(source_id, "chinese" | "mainland" | "east-asia" | "general")
}

pub fn export_package(conn: &Connection) -> AppResult<ProfilePackage> {
    let mut settings = settings::get(conn)?;
    clear_local_only_settings(&mut settings);
    let shield = settings.danmaku_shield_words.clone();
    let blocked = settings.danmaku_blocked_users.clone();
    Ok(ProfilePackage {
        version: PROFILE_VERSION,
        exported_at: chrono::Utc::now().timestamp_millis(),
        settings,
        follows: follow::list(conn)?,
        iptv_favorites: iptv_favorite::list_all(conn)?
            .into_iter()
            .filter(|favorite| is_portable_iptv_source(&favorite.source_id))
            .collect(),
        iptv_favorite_groups: iptv_favorite::list_groups(conn)?,
        tags: follow::list_tags(conn)?,
        history: history::list(conn)?,
        danmaku_shield_words: shield,
        danmaku_blocked_users: blocked,
    })
}

/// 把配置序列化为便携表示。
///
/// 字节写到哪里由调用方控制。Tauri 命令经由其文件系统插件路由输出，
/// 使 Android 的 `content://` 文档 URI 与桌面文件系统路径同样可靠。
pub fn encode_package(package: &ProfilePackage) -> AppResult<String> {
    // 即使有人扩展了模型或用手工构造的包调用这个辅助函数，
    // 也要确保 cookie 和仅限本机的控件绝不会出现。
    let value = portable_profile_value(package)?;
    if value.get("cookies").is_some() {
        return Err(AppError::new(
            "profile_security",
            "refusing to export package that contains cookies field",
        ));
    }
    serde_json::to_string_pretty(&value)
        .map_err(|e| AppError::new("profile_encode_error", format!("serialize pretty: {e}")))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileImportResult {
    pub follows: usize,
    pub iptv_favorites: usize,
    pub iptv_favorite_groups: usize,
    pub tags: usize,
    pub history: usize,
    pub settings: bool,
}

/// 从任意可读来源导入配置，包括 Android 临时文档提供器的文件描述符。
/// 文件选择器授予应用访问某个 `content://` URI 的权限，但它不是 Rust 标准
/// 文件系统能打开的路径，因此命令先经 Tauri 的文件系统插件路由，
/// 再进入这个共享解析器。
pub fn import_package_reader<R: Read>(
    conn: &mut Connection,
    reader: R,
) -> AppResult<ProfileImportResult> {
    let text = read_package_text(reader)?;
    let package = decode_package(&text)?;
    merge_into_db(conn, &package)
}

fn read_package_text<R: Read>(reader: R) -> AppResult<String> {
    let mut limited = reader.take(MAX_PROFILE_BYTES + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::new("profile_io_error", format!("read profile: {e}")))?;

    if bytes.len() as u64 > MAX_PROFILE_BYTES {
        return Err(AppError::new(
            "profile_too_large",
            format!(
                "profile is larger than the {} MiB import limit",
                MAX_PROFILE_BYTES / (1024 * 1024)
            ),
        ));
    }

    String::from_utf8(bytes)
        .map_err(|e| AppError::new("profile_decode_error", format!("profile is not UTF-8: {e}")))
}

fn decode_package(text: &str) -> AppResult<ProfilePackage> {
    let mut value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| AppError::new("profile_decode_error", format!("invalid profile json: {e}")))?;
    if let Some(version) = value.get("version").and_then(serde_json::Value::as_u64)
        && version != u64::from(PROFILE_VERSION)
    {
        return Err(AppError::new(
            "profile_version_unsupported",
            format!(
                "unsupported profile version {}; expected {}",
                version, PROFILE_VERSION
            ),
        ));
    }
    // 未知字段与缺失字段均由 serde 拥结：`ProfilePackage` 与 `AppSettings` 都带
    // `deny_unknown_fields`，且除 `BACKFILLED_SETTINGS_FIELDS` 与本机专属字段外均无
    // serde default。手写字段表曾经重建过同一套规则，但它必须随
    // `AppSettings` 手工同步，漏改就会静默改变接受面。
    fill_local_only_settings(&mut value)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::new("profile_decode_error", format!("invalid profile json: {e}")))
}

fn fill_local_only_settings(value: &mut serde_json::Value) -> AppResult<()> {
    let defaults = serde_json::to_value(AppSettings::default())
        .map_err(|error| AppError::new("profile_schema_invalid", error.to_string()))?;
    let default_settings = defaults.as_object().ok_or_else(|| {
        AppError::new(
            "profile_schema_invalid",
            "current settings defaults must be a JSON object",
        )
    })?;
    let settings = value
        .get_mut("settings")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| {
            AppError::new(
                "profile_schema_invalid",
                "profile.settings must be an object",
            )
        })?;
    for field in LOCAL_ONLY_PROFILE_SETTINGS_FIELDS {
        if !settings.contains_key(*field) {
            let default = default_settings.get(*field).ok_or_else(|| {
                AppError::new(
                    "profile_schema_invalid",
                    format!("missing current default for profile.settings.{field}"),
                )
            })?;
            settings.insert((*field).to_string(), default.clone());
        }
    }
    Ok(())
}

pub fn merge_into_db(
    conn: &mut Connection,
    package: &ProfilePackage,
) -> AppResult<ProfileImportResult> {
    // 一份便携配置覆盖七个逻辑数据组。把它们放进同一个 SQLite 事务中应用，
    // 使重复的标签或磁盘错误不会留下"关注/历史导入了一半、
    // 设置却还是旧的"这种状态。
    let transaction = conn.transaction().map_err(map_db_err)?;
    for tag in &package.tags {
        follow::upsert_tag(&transaction, tag.clone())?;
    }
    for f in &package.follows {
        follow::upsert(&transaction, f.clone())?;
    }
    for group in &package.iptv_favorite_groups {
        iptv_favorite::upsert_group(&transaction, group.clone())?;
    }
    let mut imported_iptv_favorites = 0;
    for favorite in &package.iptv_favorites {
        if is_portable_iptv_source(&favorite.source_id) {
            iptv_favorite::upsert(&transaction, favorite.clone())?;
            imported_iptv_favorites += 1;
        }
    }
    for h in &package.history {
        history::upsert(&transaction, h.clone())?;
    }

    let mut settings = settings::get(&transaction)?;
    // 从配置包合并非机密的设置字段
    settings.theme = package.settings.theme.clone();
    settings.default_site = package.settings.default_site.clone();
    settings.disabled_site_ids = package.settings.disabled_site_ids.clone();
    settings.proxy = package.settings.proxy.clone();
    settings.danmaku_opacity = package.settings.danmaku_opacity;
    settings.danmaku_font_stroke = package.settings.danmaku_font_stroke;
    settings.danmaku_font_size = package.settings.danmaku_font_size;
    settings.danmaku_speed = package.settings.danmaku_speed;
    settings.danmaku_area = package.settings.danmaku_area;
    settings.danmaku_filter_gifts = package.settings.danmaku_filter_gifts;
    settings.danmaku_merge_window_seconds = package.settings.danmaku_merge_window_seconds;
    settings.super_chat_enabled = package.settings.super_chat_enabled;
    settings.asr_font_size = package.settings.asr_font_size;
    settings.playback_soft_switch_enabled = package.settings.playback_soft_switch_enabled;
    settings.room_card_preview_enabled = package.settings.room_card_preview_enabled;
    settings.recording_ass = package.settings.recording_ass.clone();
    // 不要复制 `danmaku_send_enabled`、`asr_enabled`、`asr_provider`、
    // `asr_vad_enabled`、`asr_punctuation_enabled`、
    // `asr_speaker_diarization_enabled`、`asr_hotwords`、
    // `asr_window_seconds`、`asr_translation_*` 或 `iptv_custom_m3u_url`。
    // 配置属于便携的不可信输入；导入它不得授出发送授权、
    // 启用本设备的本地 ASR 模型，也不得替换本设备的私有播放列表地址。
    // 现有的本地取值保持不变。

    let mut words: HashSet<String> = settings.danmaku_shield_words.into_iter().collect();
    for w in &package.danmaku_shield_words {
        if !w.trim().is_empty() {
            words.insert(w.clone());
        }
    }
    for w in &package.settings.danmaku_shield_words {
        if !w.trim().is_empty() {
            words.insert(w.clone());
        }
    }
    settings.danmaku_shield_words = words.into_iter().collect();

    let mut blocked: HashSet<String> = settings.danmaku_blocked_users.into_iter().collect();
    for u in &package.danmaku_blocked_users {
        if !u.trim().is_empty() {
            blocked.insert(u.clone());
        }
    }
    for u in &package.settings.danmaku_blocked_users {
        if !u.trim().is_empty() {
            blocked.insert(u.clone());
        }
    }
    settings.danmaku_blocked_users = blocked.into_iter().collect();
    settings::set(&transaction, &settings)?;

    transaction.commit().map_err(map_db_err)?;

    Ok(ProfileImportResult {
        follows: package.follows.len(),
        iptv_favorites: imported_iptv_favorites,
        iptv_favorite_groups: package.iptv_favorite_groups.len(),
        tags: package.tags.len(),
        history: package.history.len(),
        settings: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;
    use crate::models::live::PlaybackProtocol;
    use std::io::repeat;

    fn iptv_favorite(source_id: &str, url: &str) -> IptvFavoriteRecord {
        IptvFavoriteRecord {
            source_id: source_id.into(),
            id: "news".into(),
            name: "新闻频道".into(),
            group: "新闻".into(),
            favorite_group_id: None,
            logo: None,
            url: url.into(),
            protocol: Some(PlaybackProtocol::Hls),
            headers: Default::default(),
            updated_at: 1,
        }
    }

    #[test]
    fn portable_export_omits_cookies_and_local_only_settings() {
        let mut package = ProfilePackage::sample();
        package.settings.danmaku_send_enabled = true;
        package.settings.asr_enabled = true;
        package.settings.asr_vad_enabled = true;
        package.settings.asr_punctuation_enabled = false;
        package.settings.asr_hotwords = vec!["本地热词".into()];
        package.settings.asr_speaker_diarization_enabled = true;
        package.settings.asr_translation_enabled = true;
        package.settings.asr_translation_from = "en".into();
        package.settings.asr_translation_to = "ja".into();
        package.settings.iptv_custom_m3u_url = Some("https://example.invalid/private.m3u".into());

        let v: serde_json::Value =
            serde_json::from_str(&encode_package(&package).unwrap()).unwrap();
        assert!(v.get("cookies").is_none());
        let settings = v["settings"].as_object().unwrap();
        for field in LOCAL_ONLY_PROFILE_SETTINGS_FIELDS {
            assert!(
                !settings.contains_key(*field),
                "exported local-only field {field}"
            );
        }
    }

    /// 未知字段由 `AppSettings` 的 `deny_unknown_fields` 拦下，因此错误码是 serde
    /// 路径的 `profile_decode_error`（先前由手写校验层报 `profile_schema_invalid`）。
    /// 字段名仍出现在消息里，依然能定位到具体哪个字段。
    #[test]
    fn profile_rejects_removed_settings_fields() {
        let mut value = serde_json::to_value(ProfilePackage::sample()).unwrap();
        value["settings"]["danmaku_font_weight"] = serde_json::json!(400);
        let text = serde_json::to_string(&value).unwrap();

        let error = decode_package(&text).unwrap_err();

        assert_eq!(error.code, "profile_decode_error");
        assert!(error.message.contains("danmaku_font_weight"));
    }

    /// 2.11.x 导出的配置包没有 `room_card_preview_enabled`，导入时按默认值补齐，
    /// 其余便携字段仍然必填。
    #[test]
    fn profile_backfills_room_card_preview_from_older_packages() {
        let mut value = serde_json::to_value(ProfilePackage::sample()).unwrap();
        value["settings"]
            .as_object_mut()
            .unwrap()
            .remove("room_card_preview_enabled");
        let text = serde_json::to_string(&value).unwrap();

        let package = decode_package(&text).unwrap();

        assert!(package.settings.room_card_preview_enabled);
    }

    /// 2.12.x 导出的配置包没有 `danmaku_blocked_users`（顶层与 settings 内都没有），
    /// 导入时按空列表补齐，其余便携字段仍然必填。
    #[test]
    fn profile_backfills_blocked_users_from_older_packages() {
        let mut value = serde_json::to_value(ProfilePackage::sample()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("danmaku_blocked_users");
        value["settings"]
            .as_object_mut()
            .unwrap()
            .remove("danmaku_blocked_users");
        let text = serde_json::to_string(&value).unwrap();

        let package = decode_package(&text).unwrap();

        assert!(package.danmaku_blocked_users.is_empty());
        assert!(package.settings.danmaku_blocked_users.is_empty());
    }

    #[test]
    fn profile_accepts_legacy_continue_after_leave_without_exporting_it() {
        let mut value = serde_json::to_value(ProfilePackage::sample()).unwrap();
        value["settings"]["recording_continue_after_leave"] = serde_json::json!(true);
        let text = serde_json::to_string(&value).unwrap();

        let package = decode_package(&text).unwrap();

        assert!(package.settings.legacy_recording_continue_after_leave);
        assert!(
            !serde_json::to_string(&package)
                .unwrap()
                .contains("recording_continue_after_leave")
        );
    }

    #[test]
    fn profile_rejects_legacy_global_auto_follow() {
        let mut value = serde_json::to_value(ProfilePackage::sample()).unwrap();
        value["settings"]["recording_auto_follow"] = serde_json::json!(true);
        let text = serde_json::to_string(&value).unwrap();

        let error = decode_package(&text).unwrap_err();

        assert_eq!(error.code, "profile_decode_error");
        assert!(error.message.contains("recording_auto_follow"));
    }

    #[test]
    fn profile_rejects_missing_auto_record() {
        let mut package = ProfilePackage::sample();
        package.follows.push(FollowRecord {
            site_id: "bilibili".into(),
            room_id: "1".into(),
            user_name: "u".into(),
            face: "".into(),
            tag_ids: vec![],
            auto_record: true,
            live_status: None,
            live_started_at: None,
            updated_at: 1,
        });
        let mut value = serde_json::to_value(package).unwrap();
        value["follows"][0]
            .as_object_mut()
            .unwrap()
            .remove("auto_record");

        assert!(decode_package(&serde_json::to_string(&value).unwrap()).is_err());
    }

    /// 等价性锚点：手写的 `require_fields(PORTABLE)` 与
    /// `reject_unknown_fields(PROFILE_FIELDS)` 删除后，接受面必须不变。
    ///
    /// 三个方向各验一次：便携字段缺失仍报错、本机专属字段缺失仍接受
    /// （由 `fill_local_only_settings` 回填）、顶层未知字段仍报错
    /// （由 `ProfilePackage` 的 `deny_unknown_fields` 拦下）。
    #[test]
    fn serde_alone_keeps_the_accepted_field_surface() {
        let strip = |field: &str, from_settings: bool| {
            let mut value = serde_json::to_value(ProfilePackage::sample()).unwrap();
            let object = if from_settings {
                value["settings"].as_object_mut().unwrap()
            } else {
                value.as_object_mut().unwrap()
            };
            object.remove(field);
            serde_json::to_string(&value).unwrap()
        };

        // 便携必填字段缺失 → 仍被拒绝。
        let error = decode_package(&strip("theme", true)).unwrap_err();
        assert_eq!(error.code, "profile_decode_error");
        assert!(error.message.contains("theme"));
        // 顶层必填字段缺失 → 仍被拒绝。
        assert!(decode_package(&strip("history", false)).is_err());

        // 本机专属字段缺失 → 仍然接受，且按当前默认值回填。
        let package = decode_package(&strip("asr_enabled", true)).unwrap();
        assert_eq!(
            package.settings.asr_enabled,
            AppSettings::default().asr_enabled
        );

        // 顶层未知字段 → 仍被拒绝。
        let mut value = serde_json::to_value(ProfilePackage::sample()).unwrap();
        value["unexpected_top_level"] = serde_json::json!(1);
        let error = decode_package(&serde_json::to_string(&value).unwrap()).unwrap_err();
        assert_eq!(error.code, "profile_decode_error");
        assert!(error.message.contains("unexpected_top_level"));
    }

    #[test]
    fn profile_rejects_unknown_versions() {
        let mut value = serde_json::to_value(ProfilePackage::sample()).unwrap();
        value["version"] = serde_json::json!(PROFILE_VERSION + 1);
        let text = serde_json::to_string(&value).unwrap();

        let error = decode_package(&text).unwrap_err();

        assert_eq!(error.code, "profile_version_unsupported");
    }

    #[test]
    fn portable_profile_keeps_public_iptv_favorites_and_omits_custom_ones() {
        let mut package = ProfilePackage::sample();
        package.iptv_favorite_groups = vec![IptvFavoriteGroupRecord {
            id: "news".into(),
            name: "新闻".into(),
        }];
        let mut public = iptv_favorite("chinese", "https://public.example.test/live.m3u8");
        public.favorite_group_id = Some("news".into());
        package.iptv_favorites = vec![
            public,
            iptv_favorite(
                "custom:deadbeef",
                "https://private.example.test/live.m3u8?token=secret",
            ),
        ];

        let encoded = encode_package(&package).unwrap();
        let value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        let favorites = value["iptv_favorites"].as_array().unwrap();

        assert_eq!(favorites.len(), 1);
        assert_eq!(favorites[0]["source_id"], "chinese");
        assert_eq!(favorites[0]["favorite_group_id"], "news");
        assert_eq!(value["iptv_favorite_groups"][0]["name"], "新闻");
        assert!(!encoded.contains("private.example.test"));
        assert!(!encoded.contains("token=secret"));
    }

    #[test]
    fn merge_imports_only_portable_iptv_favorites() {
        let mut conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.iptv_favorites = vec![
            iptv_favorite("mainland", "https://public.example.test/live.m3u8"),
            iptv_favorite("custom:deadbeef", "https://private.example.test/live.m3u8"),
        ];

        let result = merge_into_db(&mut conn, &package).unwrap();

        assert_eq!(result.iptv_favorites, 1);
        assert_eq!(iptv_favorite::list(&conn, "mainland").unwrap().len(), 1);
        assert!(
            iptv_favorite::list(&conn, "custom:deadbeef")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn merge_imports_iptv_groups_before_channel_assignments() {
        let mut conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.iptv_favorite_groups = vec![IptvFavoriteGroupRecord {
            id: "sports".into(),
            name: "体育".into(),
        }];
        let mut favorite = iptv_favorite("mainland", "https://public.example.test/sports.m3u8");
        favorite.favorite_group_id = Some("sports".into());
        package.iptv_favorites = vec![favorite];

        let result = merge_into_db(&mut conn, &package).unwrap();

        assert_eq!(result.iptv_favorite_groups, 1);
        assert_eq!(iptv_favorite::list_groups(&conn).unwrap()[0].name, "体育");
        assert_eq!(
            iptv_favorite::list(&conn, "mainland").unwrap()[0]
                .favorite_group_id
                .as_deref(),
            Some("sports")
        );
    }

    #[test]
    fn import_reader_rejects_an_oversized_document_before_json_parsing() {
        let error = read_package_text(repeat(b' ').take(MAX_PROFILE_BYTES + 1)).unwrap_err();

        assert_eq!(error.code, "profile_too_large");
    }

    #[test]
    fn export_package_clears_local_only_settings() {
        let conn = open_in_memory().unwrap();
        let local = AppSettings {
            danmaku_send_enabled: true,
            asr_enabled: true,
            asr_vad_enabled: true,
            asr_speaker_diarization_enabled: true,
            asr_translation_enabled: true,
            asr_translation_from: "en".into(),
            asr_translation_to: "ja".into(),
            iptv_custom_m3u_url: Some("https://example.invalid/local.m3u".into()),
            ..AppSettings::default()
        };
        settings::set(&conn, &local).unwrap();

        let package = export_package(&conn).unwrap();

        assert!(!package.settings.danmaku_send_enabled);
        assert!(!package.settings.asr_enabled);
        assert!(package.settings.asr_vad_enabled);
        assert!(package.settings.asr_punctuation_enabled);
        assert!(package.settings.asr_hotwords.is_empty());
        assert!(!package.settings.asr_speaker_diarization_enabled);
        assert!(!package.settings.asr_translation_enabled);
        assert_eq!(package.settings.asr_translation_from, "auto");
        assert_eq!(package.settings.asr_translation_to, "zh-CN");
        assert!(package.settings.iptv_custom_m3u_url.is_none());
    }

    #[test]
    fn merge_upserts_follows() {
        let mut conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.follows.push(FollowRecord {
            site_id: "bilibili".into(),
            room_id: "1".into(),
            user_name: "u".into(),
            face: "".into(),
            tag_ids: vec![],
            auto_record: true,
            live_status: None,
            live_started_at: None,
            updated_at: 1,
        });
        merge_into_db(&mut conn, &package).unwrap();
        let follows = follow::list(&conn).unwrap();
        assert_eq!(follows.len(), 1);
        assert!(follows[0].auto_record);
    }

    #[test]
    fn merge_rolls_back_every_group_when_one_record_is_invalid() {
        let mut conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.tags = vec![
            TagRecord {
                id: "first".into(),
                name: "同名标签".into(),
            },
            TagRecord {
                id: "second".into(),
                name: "同名标签".into(),
            },
        ];
        package.settings.theme = "dark".into();

        let error = merge_into_db(&mut conn, &package).unwrap_err();

        assert_eq!(error.code, "db_error");
        assert!(follow::list_tags(&conn).unwrap().is_empty());
        assert_eq!(settings::get(&conn).unwrap().theme, "system");
    }

    #[test]
    fn merge_carries_room_display_preferences() {
        let mut conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.settings.danmaku_speed = 150;
        package.settings.danmaku_font_stroke = 1.5;
        package.settings.danmaku_filter_gifts = true;
        package.settings.super_chat_enabled = false;

        merge_into_db(&mut conn, &package).unwrap();

        let imported = settings::get(&conn).unwrap();
        assert_eq!(imported.danmaku_speed, 150);
        assert_eq!(imported.danmaku_font_stroke, 1.5);
        assert!(imported.danmaku_filter_gifts);
        assert!(!imported.super_chat_enabled);
    }

    #[test]
    fn merge_carries_recording_ass_preferences() {
        let mut conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.settings.recording_ass.resolution_width = 3840;
        package.settings.recording_ass.resolution_height = 2160;
        package.settings.recording_ass.font_name = "Noto Sans SC".into();
        package.settings.recording_ass.font_size = 72;

        merge_into_db(&mut conn, &package).unwrap();

        let ass = settings::get(&conn).unwrap().recording_ass;
        assert_eq!(ass.resolution_width, 3840);
        assert_eq!(ass.resolution_height, 2160);
        assert_eq!(ass.font_name, "Noto Sans SC");
        assert_eq!(ass.font_size, 72);
    }

    #[test]
    fn merge_carries_platform_visibility_preferences() {
        let mut conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.settings.disabled_site_ids = vec!["huya".into(), "douyin".into()];
        package.settings.default_site = "douyu".into();

        merge_into_db(&mut conn, &package).unwrap();

        let settings = settings::get(&conn).unwrap();
        assert_eq!(settings.disabled_site_ids, vec!["huya", "douyin"]);
        assert_eq!(settings.default_site, "douyu");
    }

    #[test]
    fn merge_unions_shield_words_and_blocked_users() {
        let mut conn = open_in_memory().unwrap();
        let local = AppSettings {
            danmaku_shield_words: vec!["本地词".into()],
            danmaku_blocked_users: vec!["本地用户".into()],
            ..Default::default()
        };
        settings::set(&conn, &local).unwrap();

        let mut package = ProfilePackage::sample();
        package.settings.danmaku_shield_words = vec!["包内词".into(), "".into()];
        package.settings.danmaku_blocked_users = vec!["包内用户".into(), " ".into()];
        package.danmaku_shield_words = vec!["顶层词".into()];
        package.danmaku_blocked_users = vec!["顶层用户".into()];

        merge_into_db(&mut conn, &package).unwrap();

        let after = settings::get(&conn).unwrap();
        let mut shield = after.danmaku_shield_words.clone();
        let mut blocked = after.danmaku_blocked_users.clone();
        shield.sort();
        blocked.sort();
        assert_eq!(shield, vec!["包内词", "本地词", "顶层词"]);
        assert_eq!(blocked, vec!["包内用户", "本地用户", "顶层用户"]);
    }

    #[test]
    fn merge_preserves_local_only_settings() {
        let mut conn = open_in_memory().unwrap();
        let local = AppSettings {
            danmaku_send_enabled: true,
            asr_enabled: true,
            asr_vad_enabled: true,
            asr_punctuation_enabled: false,
            asr_hotwords: vec!["本地热词".into()],
            asr_speaker_diarization_enabled: true,
            asr_translation_enabled: true,
            asr_translation_from: "en".into(),
            asr_translation_to: "ja".into(),
            iptv_custom_m3u_url: Some("https://example.invalid/local.m3u".into()),
            ..AppSettings::default()
        };
        settings::set(&conn, &local).unwrap();

        let mut package = ProfilePackage::sample();
        package.settings.danmaku_send_enabled = false;
        package.settings.asr_enabled = false;
        package.settings.asr_vad_enabled = false;
        package.settings.asr_speaker_diarization_enabled = false;
        package.settings.asr_translation_enabled = false;
        package.settings.asr_translation_from = "ru".into();
        package.settings.asr_translation_to = "de".into();
        package.settings.iptv_custom_m3u_url =
            Some("https://untrusted.example.invalid/playlist.m3u".into());

        merge_into_db(&mut conn, &package).unwrap();

        let after = settings::get(&conn).unwrap();
        assert!(after.danmaku_send_enabled);
        assert!(after.asr_enabled);
        assert!(after.asr_vad_enabled);
        assert!(!after.asr_punctuation_enabled);
        assert_eq!(after.asr_hotwords, vec!["本地热词"]);
        assert!(after.asr_speaker_diarization_enabled);
        assert!(after.asr_translation_enabled);
        assert_eq!(after.asr_translation_from, "en");
        assert_eq!(after.asr_translation_to, "ja");
        assert_eq!(
            after.iptv_custom_m3u_url.as_deref(),
            Some("https://example.invalid/local.m3u")
        );
    }

    #[test]
    fn merge_cannot_grant_shared_send_permission_from_profile() {
        let mut conn = open_in_memory().unwrap();
        let local = AppSettings::default();
        assert!(!local.danmaku_send_enabled);
        settings::set(&conn, &local).unwrap();

        let mut package = ProfilePackage::sample();
        package.settings.danmaku_send_enabled = true;

        merge_into_db(&mut conn, &package).unwrap();

        assert!(!settings::get(&conn).unwrap().danmaku_send_enabled);
    }
}
