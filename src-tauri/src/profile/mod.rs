use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;

use crate::db::follow::{self, FollowRecord, TagRecord};
use crate::db::history::{self, HistoryRecord};
use crate::db::schema::map_db_err;
use crate::error::{AppError, AppResult};
use crate::models::settings::AppSettings;
use crate::settings;
use rusqlite::Connection;

/// Profile packages contain structured settings and history, but are never
/// expected to carry media or model data. Bound the read before JSON parsing
/// so a malformed Android content URI (or an accidental video selection)
/// cannot make an import allocate without limit.
const MAX_PROFILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfilePackage {
    pub version: u32,
    pub exported_at: i64,
    pub settings: AppSettings,
    pub follows: Vec<FollowRecord>,
    pub tags: Vec<TagRecord>,
    pub history: Vec<HistoryRecord>,
    pub danmaku_shield_words: Vec<String>,
}

impl ProfilePackage {
    #[cfg(test)]
    fn sample() -> Self {
        Self {
            version: 1,
            exported_at: 0,
            settings: AppSettings::default(),
            follows: vec![],
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

    let mut value = serde_json::to_value(portable)
        .map_err(|e| AppError::new("profile_encode_error", format!("serialize: {e}")))?;
    if let Some(settings) = value
        .get_mut("settings")
        .and_then(|value| value.as_object_mut())
    {
        // Omit rather than serialize safe-looking defaults so future import
        // changes cannot mistake these device-local choices for portable data.
        settings.remove("danmaku_send_enabled");
        settings.remove("iptv_custom_m3u_url");
    }
    Ok(value)
}

pub fn export_package(conn: &Connection) -> AppResult<ProfilePackage> {
    let mut settings = settings::get(conn)?;
    clear_local_only_settings(&mut settings);
    let shield = settings.danmaku_shield_words.clone();
    Ok(ProfilePackage {
        version: 1,
        exported_at: chrono::Utc::now().timestamp_millis(),
        settings,
        follows: follow::list(conn)?,
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
    serde_json::from_str(text)
        .map_err(|e| AppError::new("profile_decode_error", format!("invalid profile json: {e}")))
}

pub fn merge_into_db(
    conn: &mut Connection,
    package: &ProfilePackage,
) -> AppResult<ProfileImportResult> {
    // A portable profile spans five logical data groups. Apply all of them in
    // one SQLite transaction so a duplicate tag or disk error cannot leave
    // follows/history partially imported while the settings remain old.
    let transaction = conn.transaction().map_err(map_db_err)?;
    for tag in &package.tags {
        follow::upsert_tag(&transaction, tag.clone())?;
    }
    for f in &package.follows {
        follow::upsert(&transaction, f.clone())?;
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
    settings.danmaku_font_size = package.settings.danmaku_font_size;
    settings.danmaku_speed = package.settings.danmaku_speed;
    settings.danmaku_area = package.settings.danmaku_area;
    settings.danmaku_line_count = package.settings.danmaku_line_count;
    settings.danmaku_font_weight = package.settings.danmaku_font_weight;
    settings.danmaku_filter_repeats = package.settings.danmaku_filter_repeats;
    settings.danmaku_filter_gifts = package.settings.danmaku_filter_gifts;
    // Do not copy `danmaku_send_enabled` or `iptv_custom_m3u_url`.
    // A profile is portable/untrusted input; importing it must not grant
    // sending consent, replace this device's private playlist address, or
    // replace this device's private playlist address.
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
        tags: package.tags.len(),
        history: package.history.len(),
        settings: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;
    use std::io::repeat;

    #[test]
    fn portable_export_omits_cookies_and_local_only_settings() {
        let mut package = ProfilePackage::sample();
        package.settings.danmaku_send_enabled = true;
        package.settings.iptv_custom_m3u_url = Some("https://example.invalid/private.m3u".into());

        let v = portable_profile_value(&package).unwrap();
        assert!(v.get("cookies").is_none());
        let settings = v["settings"].as_object().unwrap();
        assert!(!settings.contains_key("danmaku_send_enabled"));
        assert!(!settings.contains_key("iptv_custom_m3u_url"));

        let text = encode_package(&package).unwrap();
        assert!(!text.contains("danmaku_send_enabled"));
        assert!(!text.contains("iptv_custom_m3u_url"));
    }

    #[test]
    fn import_reader_rejects_an_oversized_document_before_json_parsing() {
        let error = read_package_text(repeat(b' ').take(MAX_PROFILE_BYTES + 1)).unwrap_err();

        assert_eq!(error.code, "profile_too_large");
    }

    #[test]
    fn export_package_clears_local_only_settings() {
        let conn = open_in_memory().unwrap();
        let mut local = AppSettings::default();
        local.danmaku_send_enabled = true;
        local.iptv_custom_m3u_url = Some("https://example.invalid/local.m3u".into());
        settings::set(&conn, &local).unwrap();

        let package = export_package(&conn).unwrap();

        assert!(!package.settings.danmaku_send_enabled);
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
            live_status: None,
            live_started_at: None,
            updated_at: 1,
        });
        merge_into_db(&mut conn, &package).unwrap();
        assert_eq!(follow::list(&conn).unwrap().len(), 1);
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
    fn merge_carries_the_gift_filter_preference() {
        let mut conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.settings.danmaku_filter_gifts = true;

        merge_into_db(&mut conn, &package).unwrap();

        assert!(settings::get(&conn).unwrap().danmaku_filter_gifts);
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
        let mut local = AppSettings::default();
        local.danmaku_send_enabled = true;
        local.iptv_custom_m3u_url = Some("https://example.invalid/local.m3u".into());
        settings::set(&conn, &local).unwrap();

        let mut package = ProfilePackage::sample();
        package.settings.danmaku_send_enabled = false;
        package.settings.iptv_custom_m3u_url =
            Some("https://untrusted.example.invalid/playlist.m3u".into());

        merge_into_db(&mut conn, &package).unwrap();

        let after = settings::get(&conn).unwrap();
        assert!(after.danmaku_send_enabled);
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
