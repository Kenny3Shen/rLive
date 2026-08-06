use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashSet;

use crate::db::schema::map_db_err;
use crate::error::{AppError, AppResult};
use crate::models::AppSettings;

const SETTINGS_KEY: &str = "app_settings";
const DANMAKU_MERGE_WINDOW_SECONDS_MIN: u32 = 5;
const DANMAKU_MERGE_WINDOW_SECONDS_MAX: u32 = 30;

/// Repairs platform visibility preferences from hand-edited or future settings
/// records. The UI prevents this state already, but settings are imported and
/// written through more than one path, so the persisted representation also
/// guarantees one visible platform and an enabled default selection.
fn normalize_site_preferences(settings: &mut AppSettings) {
    let known_site_ids: Vec<&str> = crate::sites::registry::all_meta()
        .into_iter()
        .map(|site| site.id.as_str())
        .collect();
    if known_site_ids.is_empty() {
        return;
    }

    let mut disabled_site_ids: HashSet<&str> = settings
        .disabled_site_ids
        .iter()
        .map(String::as_str)
        .collect();

    // A malformed settings file may opt out of every bundled platform. Keep
    // the stable first platform as a safe recovery path instead of making the
    // application impossible to navigate.
    if known_site_ids
        .iter()
        .all(|site_id| disabled_site_ids.contains(*site_id))
    {
        let fallback_site_id = known_site_ids[0];
        settings
            .disabled_site_ids
            .retain(|site_id| site_id.as_str() != fallback_site_id);
        disabled_site_ids = settings
            .disabled_site_ids
            .iter()
            .map(String::as_str)
            .collect();
    }

    let default_site_is_enabled = known_site_ids
        .iter()
        .any(|site_id| *site_id == settings.default_site)
        && !disabled_site_ids.contains(settings.default_site.as_str());
    if default_site_is_enabled {
        return;
    }

    let fallback_site_id = known_site_ids
        .iter()
        .copied()
        .find(|site_id| !disabled_site_ids.contains(site_id))
        .unwrap_or(known_site_ids[0]);
    settings.default_site = fallback_site_id.to_owned();
}

fn normalize_asr_preferences(settings: &mut AppSettings) {
    if !settings.asr_window_seconds.is_finite() {
        settings.asr_window_seconds = 0.2;
    } else {
        let bounded = settings.asr_window_seconds.clamp(0.2, 1.0);
        settings.asr_window_seconds = (bounded * 10.0).round() / 10.0;
    }

    let mut seen = HashSet::new();
    settings.asr_hotwords.retain_mut(|word| {
        *word = word
            .chars()
            .filter(|character| !character.is_control())
            .collect::<String>()
            .trim()
            .to_owned();
        if word.is_empty() || word.chars().count() > 80 {
            return false;
        }
        seen.insert(word.to_lowercase())
    });
    settings.asr_hotwords.truncate(100);
}

fn normalize_danmaku_preferences(settings: &mut AppSettings) {
    settings.danmaku_merge_window_seconds = settings.danmaku_merge_window_seconds.clamp(
        DANMAKU_MERGE_WINDOW_SECONDS_MIN,
        DANMAKU_MERGE_WINDOW_SECONDS_MAX,
    );
}

/// Load app settings from `settings_kv`, or return defaults if missing/invalid.
pub fn get(conn: &Connection) -> AppResult<AppSettings> {
    Ok(get_with_status(conn)?.0)
}

/// Load settings along with whether a valid saved settings record exists.
///
/// The distinction lets the frontend retain a legacy local platform choice
/// when it is being run against a database that has not saved settings yet.
pub fn get_with_status(conn: &Connection) -> AppResult<(AppSettings, bool)> {
    let mut stmt = conn
        .prepare("SELECT value FROM settings_kv WHERE key = ?1")
        .map_err(map_db_err)?;
    let raw: Option<String> = stmt
        .query_row(params![SETTINGS_KEY], |row| row.get(0))
        .optional()
        .map_err(map_db_err)?;

    match raw {
        None => Ok((AppSettings::default(), false)),
        Some(json) => match serde_json::from_str(&json) {
            Ok(mut settings) => {
                normalize_site_preferences(&mut settings);
                normalize_danmaku_preferences(&mut settings);
                normalize_asr_preferences(&mut settings);
                Ok((settings, true))
            }
            // Corrupt JSON: fall back to defaults so the app remains usable.
            Err(_) => Ok((AppSettings::default(), false)),
        },
    }
}

/// Persist full app settings under key `app_settings`.
pub fn set(conn: &Connection, settings: &AppSettings) -> AppResult<()> {
    let mut normalized = settings.clone();
    normalize_site_preferences(&mut normalized);
    normalize_danmaku_preferences(&mut normalized);
    normalize_asr_preferences(&mut normalized);
    let json = serde_json::to_string(&normalized).map_err(|e| {
        AppError::new(
            "settings_encode_error",
            format!("failed to encode app_settings: {e}"),
        )
    })?;
    conn.execute(
        "INSERT INTO settings_kv (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SETTINGS_KEY, json],
    )
    .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

    #[test]
    fn get_returns_defaults_when_empty() {
        let conn = open_in_memory().unwrap();
        let (s, has_saved_settings) = get_with_status(&conn).unwrap();
        assert!(!has_saved_settings);
        assert_eq!(s.default_site, "bilibili");
        assert_eq!(s.theme, "system");
        assert_eq!(s.danmaku_opacity, 0.8);
        assert_eq!(s.danmaku_font_size, 18);
        assert_eq!(s.danmaku_speed, 8);
        assert_eq!(s.danmaku_area, 0.9);
        assert_eq!(s.danmaku_line_count, 0);
        assert_eq!(s.danmaku_font_weight, 600);
        assert!(s.danmaku_filter_repeats);
        assert!(s.danmaku_filter_gifts);
        assert_eq!(s.danmaku_merge_window_seconds, 10);
        assert!(s.super_chat_enabled);
        assert_eq!(s.asr_font_size, 20);
        assert!(s.asr_vad_enabled);
        assert!(s.asr_punctuation_enabled);
        assert!(s.asr_hotwords.is_empty());
        assert!(s.danmaku_shield_words.is_empty());
        assert!(s.proxy.is_none());
    }

    #[test]
    fn set_and_get_roundtrip() {
        let conn = open_in_memory().unwrap();
        let mut s = AppSettings::default();
        s.theme = "dark".into();
        s.proxy = Some("http://127.0.0.1:7890".into());
        s.iptv_custom_m3u_url = Some("https://example.invalid/private.m3u".into());
        s.danmaku_font_size = 22;
        set(&conn, &s).unwrap();
        let (back, has_saved_settings) = get_with_status(&conn).unwrap();
        assert!(has_saved_settings);
        assert_eq!(back, s);
    }

    #[test]
    fn set_clamps_danmaku_merge_window() {
        let conn = open_in_memory().unwrap();
        let mut settings = AppSettings {
            danmaku_merge_window_seconds: 1,
            ..AppSettings::default()
        };

        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().danmaku_merge_window_seconds, 5);

        settings.danmaku_merge_window_seconds = 60;
        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().danmaku_merge_window_seconds, 30);
    }

    #[test]
    fn set_normalizes_local_asr_hotwords() {
        let conn = open_in_memory().unwrap();
        let mut settings = AppSettings {
            asr_hotwords: vec![
                " 主播昵称 ".into(),
                "主播昵称".into(),
                "GAME".into(),
                "game".into(),
                "\t".into(),
            ],
            ..AppSettings::default()
        };

        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().asr_hotwords, vec!["主播昵称", "GAME"]);

        settings.asr_hotwords = (0..120).map(|index| format!("热词{index}")).collect();
        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().asr_hotwords.len(), 100);
    }

    #[test]
    fn set_keeps_one_platform_enabled_when_all_are_disabled() {
        let conn = open_in_memory().unwrap();
        let mut settings = AppSettings::default();
        settings.default_site = "douyin".into();
        settings.disabled_site_ids = crate::sites::registry::all_meta()
            .into_iter()
            .map(|site| site.id.as_str().to_owned())
            .collect();

        set(&conn, &settings).unwrap();
        let (back, has_saved_settings) = get_with_status(&conn).unwrap();

        assert!(has_saved_settings);
        assert_eq!(back.default_site, "bilibili");
        assert!(!back.disabled_site_ids.iter().any(|site| site == "bilibili"));
    }

    #[test]
    fn get_returns_defaults_on_corrupt_json() {
        let conn = open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO settings_kv (key, value) VALUES (?1, ?2)",
            params![SETTINGS_KEY, "{not-valid-json"],
        )
        .unwrap();
        let (s, has_saved_settings) = get_with_status(&conn).unwrap();
        assert!(!has_saved_settings);
        assert_eq!(s, AppSettings::default());
    }
}
