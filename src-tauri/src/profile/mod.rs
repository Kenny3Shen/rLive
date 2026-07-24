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
    pub fn sample() -> Self {
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

pub fn export_package(conn: &Connection) -> AppResult<ProfilePackage> {
    let settings = settings::get(conn)?;
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
    // Ensure cookies never appear even if someone extends the model later.
    let value = serde_json::to_value(package)
        .map_err(|e| AppError::new("profile_encode_error", format!("serialize: {e}")))?;
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
    settings.proxy = package.settings.proxy.clone();
    settings.danmaku_opacity = package.settings.danmaku_opacity;
    settings.danmaku_font_size = package.settings.danmaku_font_size;
    settings.danmaku_speed = package.settings.danmaku_speed;
    settings.danmaku_area = package.settings.danmaku_area;
    settings.danmaku_line_count = package.settings.danmaku_line_count;
    settings.danmaku_font_weight = package.settings.danmaku_font_weight;
    settings.danmaku_filter_repeats = package.settings.danmaku_filter_repeats;
    settings.mpv_path = package.settings.mpv_path.clone();

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
    fn export_model_has_no_cookie_field() {
        let v = serde_json::to_value(ProfilePackage::sample()).unwrap();
        assert!(v.get("cookies").is_none());
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
            updated_at: 1,
        });
        merge_into_db(&conn, &package).unwrap();
        assert_eq!(follow::list(&conn).unwrap().len(), 1);
    }
}
