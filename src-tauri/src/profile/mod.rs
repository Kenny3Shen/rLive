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
const PROFILE_FIELDS: &[&str] = &[
    "version",
    "exported_at",
    "settings",
    "follows",
    "iptv_favorites",
    "iptv_favorite_groups",
    "tags",
    "history",
    "danmaku_shield_words",
];
const PROFILE_SETTINGS_FIELDS: &[&str] = &[
    "theme",
    "default_site",
    "disabled_site_ids",
    "proxy",
    "danmaku_opacity",
    "danmaku_font_stroke",
    "danmaku_font_size",
    "danmaku_speed",
    "danmaku_area",
    "danmaku_merge_window_seconds",
    "danmaku_filter_gifts",
    "super_chat_enabled",
    "danmaku_shield_words",
    "quality_level",
    "playback_soft_switch_enabled",
    "danmaku_send_enabled",
    "asr_enabled",
    "asr_provider",
    "asr_vad_enabled",
    "asr_punctuation_enabled",
    "asr_speaker_diarization_enabled",
    "asr_hotwords",
    "asr_window_seconds",
    "asr_font_size",
    "asr_translation_enabled",
    "asr_translation_from",
    "asr_translation_to",
    "iptv_custom_m3u_url",
    // Accepted from packages written before background recording became
    // unconditional, then dropped rather than applied. It is deliberately not
    // in the portable (required) list, so current exports may omit it.
    "recording_continue_after_leave",
    "recording_include_danmaku",
    "recording_auto_split_minutes",
    "ffmpeg_rw_timeout_seconds",
    "ffmpeg_reconnect_delay_max_seconds",
    "ffmpeg_hls_segment_retry_count",
    "recording_ass",
];
const PORTABLE_PROFILE_SETTINGS_FIELDS: &[&str] = &[
    "theme",
    "default_site",
    "disabled_site_ids",
    "proxy",
    "danmaku_opacity",
    "danmaku_font_stroke",
    "danmaku_font_size",
    "danmaku_speed",
    "danmaku_area",
    "danmaku_merge_window_seconds",
    "danmaku_filter_gifts",
    "super_chat_enabled",
    "danmaku_shield_words",
    "quality_level",
    "playback_soft_switch_enabled",
    "asr_font_size",
    "recording_include_danmaku",
    "recording_auto_split_minutes",
    "ffmpeg_rw_timeout_seconds",
    "ffmpeg_reconnect_delay_max_seconds",
    "ffmpeg_hls_segment_retry_count",
    "recording_ass",
];
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

/// Profile packages contain structured settings and history, but are never
/// expected to carry media or model data. Bound the read before JSON parsing
/// so a malformed Android content URI (or an accidental video selection)
/// cannot make an import allocate without limit.
pub(crate) const MAX_PROFILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
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
        }
    }
}

/// These controls intentionally never leave the current device with a profile.
///
/// The danmaku-send toggle is an explicit consent for a write action, and a
/// custom M3U URL can identify a private playlist or carry an access token.
/// An imported profile must not be able to choose either of them.
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

/// Convert a package into the portable on-disk representation.
///
/// Keep the defensive stripping here as well as in [`export_package`]: callers
/// of [`encode_package`] should not accidentally export local-only controls
/// when they construct a `ProfilePackage` themselves.
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
        // Omit rather than serialize safe-looking defaults so future import
        // changes cannot mistake these device-local choices for portable data.
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
    })
}

/// Serialize a profile into its portable representation.
///
/// The caller controls where the bytes are written. The Tauri command routes
/// the output through its filesystem plugin so Android `content://` document
/// URIs work just as reliably as desktop filesystem paths.
pub fn encode_package(package: &ProfilePackage) -> AppResult<String> {
    // Ensure cookies and local-only controls never appear even if someone
    // extends the model or invokes this helper with a hand-built package.
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

/// Imports a profile from any readable source, including Android's temporary
/// document-provider file descriptor. The file picker grants the app access to
/// a `content://` URI but it is not a path Rust's standard filesystem can
/// open, so commands route it through Tauri's filesystem plugin and into this
/// shared parser.
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
    reject_unknown_fields(&value, "profile", PROFILE_FIELDS)?;
    require_fields(&value, "profile", PROFILE_FIELDS)?;
    let settings = value
        .get("settings")
        .ok_or_else(|| AppError::new("profile_schema_invalid", "profile.settings is required"))?;
    reject_unknown_fields(settings, "profile.settings", PROFILE_SETTINGS_FIELDS)?;
    require_fields(
        settings,
        "profile.settings",
        PORTABLE_PROFILE_SETTINGS_FIELDS,
    )?;
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

fn reject_unknown_fields(
    value: &serde_json::Value,
    path: &str,
    allowed_fields: &[&str],
) -> AppResult<()> {
    let object = value.as_object().ok_or_else(|| {
        AppError::new(
            "profile_schema_invalid",
            format!("{path} must be a JSON object"),
        )
    })?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed_fields.contains(&field.as_str()))
    {
        return Err(AppError::new(
            "profile_schema_invalid",
            format!("unknown field {path}.{field}"),
        ));
    }
    Ok(())
}

fn require_fields(
    value: &serde_json::Value,
    path: &str,
    required_fields: &[&str],
) -> AppResult<()> {
    let object = value.as_object().ok_or_else(|| {
        AppError::new(
            "profile_schema_invalid",
            format!("{path} must be a JSON object"),
        )
    })?;
    if let Some(field) = required_fields
        .iter()
        .find(|field| !object.contains_key(**field))
    {
        return Err(AppError::new(
            "profile_schema_invalid",
            format!("missing field {path}.{field}"),
        ));
    }
    Ok(())
}

pub fn merge_into_db(
    conn: &mut Connection,
    package: &ProfilePackage,
) -> AppResult<ProfileImportResult> {
    // A portable profile spans seven logical data groups. Apply all of them in
    // one SQLite transaction so a duplicate tag or disk error cannot leave
    // follows/history partially imported while the settings remain old.
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
    // Merge non-secret settings fields from package
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
    settings.recording_ass = package.settings.recording_ass.clone();
    // Do not copy `danmaku_send_enabled`, `asr_enabled`, `asr_provider`,
    // `asr_vad_enabled`, `asr_punctuation_enabled`,
    // `asr_speaker_diarization_enabled`, `asr_hotwords`,
    // `asr_window_seconds`, `asr_translation_*`, or `iptv_custom_m3u_url`.
    // A profile is portable/untrusted input; importing it must not grant
    // sending consent, enable this device's local ASR model, or replace this
    // device's private playlist address.
    // Existing local values are kept.

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

    #[test]
    fn profile_rejects_removed_settings_fields() {
        let mut value = serde_json::to_value(ProfilePackage::sample()).unwrap();
        value["settings"]["danmaku_font_weight"] = serde_json::json!(400);
        let text = serde_json::to_string(&value).unwrap();

        let error = decode_package(&text).unwrap_err();

        assert_eq!(error.code, "profile_schema_invalid");
        assert!(error.message.contains("danmaku_font_weight"));
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

        assert_eq!(error.code, "profile_schema_invalid");
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
