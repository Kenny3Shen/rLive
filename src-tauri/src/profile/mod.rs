use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

use crate::db::follow::{self, FollowRecord, TagRecord};
use crate::db::history::{self, HistoryRecord};
use crate::error::{AppError, AppResult};
use crate::models::settings::AppSettings;
use crate::settings;
use rusqlite::Connection;

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
/// custom M3U URL can identify a private playlist or carry an access token. An
/// imported profile must not be able to choose either of them.
fn clear_local_only_settings(settings: &mut AppSettings) {
    settings.danmaku_send_enabled = false;
    settings.iptv_custom_m3u_url = None;
}

/// Convert a package into the portable on-disk representation.
///
/// Keep the defensive stripping here as well as in [`export_package`]: callers
/// of `write_package` should not accidentally export local-only controls when
/// they construct a `ProfilePackage` themselves.
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

pub fn write_package(path: &Path, package: &ProfilePackage) -> AppResult<()> {
    // Ensure cookies and local-only controls never appear even if someone
    // extends the model or invokes this helper with a hand-built package.
    let value = portable_profile_value(package)?;
    if value.get("cookies").is_some() {
        return Err(AppError::new(
            "profile_security",
            "refusing to export package that contains cookies field",
        ));
    }
    let text = serde_json::to_string_pretty(&value)
        .map_err(|e| AppError::new("profile_encode_error", format!("serialize pretty: {e}")))?;
    std::fs::write(path, text)
        .map_err(|e| AppError::new("profile_io_error", format!("write {}: {e}", path.display())))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileImportResult {
    pub follows: usize,
    pub tags: usize,
    pub history: usize,
    pub settings: bool,
}

pub fn import_package(conn: &Connection, path: &Path) -> AppResult<ProfileImportResult> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| AppError::new("profile_io_error", format!("read {}: {e}", path.display())))?;
    let package: ProfilePackage = serde_json::from_str(&text)
        .map_err(|e| AppError::new("profile_decode_error", format!("invalid profile json: {e}")))?;
    merge_into_db(conn, &package)
}

pub fn merge_into_db(
    conn: &Connection,
    package: &ProfilePackage,
) -> AppResult<ProfileImportResult> {
    for tag in &package.tags {
        follow::upsert_tag(conn, tag.clone())?;
    }
    for f in &package.follows {
        follow::upsert(conn, f.clone())?;
    }
    for h in &package.history {
        history::upsert(conn, h.clone())?;
    }

    let mut settings = settings::get(conn)?;
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
    settings.mpv_path = package.settings.mpv_path.clone();
    // Do not copy `danmaku_send_enabled` or `iptv_custom_m3u_url`.
    // A profile is portable/untrusted input; importing it must not grant
    // sending consent or replace this device's private playlist address.
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
    settings::set(conn, &settings)?;

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
        let conn = open_in_memory().unwrap();
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
        merge_into_db(&conn, &package).unwrap();
        assert_eq!(follow::list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn merge_carries_the_gift_filter_preference() {
        let conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.settings.danmaku_filter_gifts = true;

        merge_into_db(&conn, &package).unwrap();

        assert!(settings::get(&conn).unwrap().danmaku_filter_gifts);
    }

    #[test]
    fn merge_carries_platform_visibility_preferences() {
        let conn = open_in_memory().unwrap();
        let mut package = ProfilePackage::sample();
        package.settings.disabled_site_ids = vec!["kuaishou".into(), "douyin".into()];
        package.settings.default_site = "douyu".into();

        merge_into_db(&conn, &package).unwrap();

        let settings = settings::get(&conn).unwrap();
        assert_eq!(settings.disabled_site_ids, vec!["kuaishou", "douyin"]);
        assert_eq!(settings.default_site, "douyu");
    }

    #[test]
    fn merge_preserves_local_only_settings() {
        let conn = open_in_memory().unwrap();
        let mut local = AppSettings::default();
        local.danmaku_send_enabled = true;
        local.iptv_custom_m3u_url = Some("https://example.invalid/local.m3u".into());
        settings::set(&conn, &local).unwrap();

        let mut package = ProfilePackage::sample();
        package.settings.danmaku_send_enabled = false;
        package.settings.iptv_custom_m3u_url =
            Some("https://untrusted.example.invalid/playlist.m3u".into());

        merge_into_db(&conn, &package).unwrap();

        let after = settings::get(&conn).unwrap();
        assert!(after.danmaku_send_enabled);
        assert_eq!(
            after.iptv_custom_m3u_url.as_deref(),
            Some("https://example.invalid/local.m3u")
        );
    }

    #[test]
    fn merge_cannot_grant_shared_send_permission_from_profile() {
        let conn = open_in_memory().unwrap();
        let local = AppSettings::default();
        assert!(!local.danmaku_send_enabled);
        settings::set(&conn, &local).unwrap();

        let mut package = ProfilePackage::sample();
        package.settings.danmaku_send_enabled = true;

        merge_into_db(&conn, &package).unwrap();

        assert!(!settings::get(&conn).unwrap().danmaku_send_enabled);
    }
}
