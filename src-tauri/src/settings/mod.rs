use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashSet;

use crate::db::schema::map_db_err;
use crate::error::{AppError, AppResult};
use crate::models::AppSettings;

const SETTINGS_KEY: &str = "app_settings";
const DANMAKU_SPEED_MIN: u32 = 50;
const DANMAKU_SPEED_MAX: u32 = 200;
const DANMAKU_FONT_STROKE_MIN: f32 = 0.0;
const DANMAKU_FONT_STROKE_MAX: f32 = 1.5;
const DANMAKU_FONT_STROKE_DEFAULT: f32 = 0.0;
const DANMAKU_MERGE_WINDOW_SECONDS_MIN: u32 = 0;
const DANMAKU_MERGE_WINDOW_SECONDS_MAX: u32 = 30;
const FFMPEG_RW_TIMEOUT_SECONDS_MIN: u32 = 3;
const FFMPEG_RW_TIMEOUT_SECONDS_MAX: u32 = 60;
const FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN: u32 = 1;
const FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX: u32 = 60;
const FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX: u32 = 20;
const RECORDING_AUTO_SPLIT_MINUTES_MAX: u32 = 24 * 60;
const RECORDING_ASS_RESOLUTION_WIDTH_MIN: u32 = 320;
const RECORDING_ASS_RESOLUTION_WIDTH_MAX: u32 = 7_680;
const RECORDING_ASS_RESOLUTION_HEIGHT_MIN: u32 = 240;
const RECORDING_ASS_RESOLUTION_HEIGHT_MAX: u32 = 4_320;
const RECORDING_ASS_FONT_SIZE_MIN: u32 = 8;
const RECORDING_ASS_FONT_SIZE_MAX: u32 = 160;
const RECORDING_ASS_STYLE_WIDTH_MAX: f32 = 4.0;
const RECORDING_ASS_SCROLL_DURATION_SECONDS_MIN: u32 = 1;
const RECORDING_ASS_SCROLL_DURATION_SECONDS_MAX: u32 = 60;
const RECORDING_ASS_DISPLAY_AREA_PERCENT_MIN: u32 = 10;
const RECORDING_ASS_DISPLAY_AREA_PERCENT_MAX: u32 = 100;
const RECORDING_ASS_MAX_DELAY_SECONDS_MAX: u32 = 30;
const RECORDING_ASS_MERGE_WINDOW_SECONDS_MAX: u32 = 30;
const RECORDING_ASS_FONT_NAME_MAX_CHARS: usize = 80;
const RECORDING_ASS_SHIELD_RULE_MAX_CHARS: usize = 200;
const RECORDING_ASS_SHIELD_RULE_MAX_COUNT: usize = 100;

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
    if !matches!(settings.asr_provider.as_str(), "auto" | "cpu" | "cuda") {
        settings.asr_provider = "auto".to_owned();
    }

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

    if settings.asr_translation_from != "auto"
        && !is_supported_translation_language(&settings.asr_translation_from)
    {
        settings.asr_translation_from = "auto".to_owned();
    }
    if settings.asr_translation_to != "auto"
        && !is_supported_translation_language(&settings.asr_translation_to)
    {
        settings.asr_translation_to = "zh-CN".to_owned();
    }
    if settings.asr_translation_from != "auto"
        && settings.asr_translation_from == settings.asr_translation_to
    {
        settings.asr_translation_from = "auto".to_owned();
    }
}

fn is_supported_translation_language(language: &str) -> bool {
    matches!(
        language,
        "ar" | "de"
            | "en"
            | "es"
            | "fr"
            | "hi"
            | "id"
            | "it"
            | "ja"
            | "ko"
            | "ms"
            | "nl"
            | "pl"
            | "pt"
            | "ru"
            | "th"
            | "tr"
            | "uk"
            | "vi"
            | "zh-CN"
            | "zh-TW"
    )
}

fn normalize_danmaku_preferences(settings: &mut AppSettings) {
    settings.danmaku_font_stroke = if settings.danmaku_font_stroke.is_finite() {
        let bounded = settings
            .danmaku_font_stroke
            .clamp(DANMAKU_FONT_STROKE_MIN, DANMAKU_FONT_STROKE_MAX);
        (bounded * 2.0).round() / 2.0
    } else {
        DANMAKU_FONT_STROKE_DEFAULT
    };
    settings.danmaku_speed = settings
        .danmaku_speed
        .clamp(DANMAKU_SPEED_MIN, DANMAKU_SPEED_MAX);
    settings.danmaku_merge_window_seconds = settings.danmaku_merge_window_seconds.clamp(
        DANMAKU_MERGE_WINDOW_SECONDS_MIN,
        DANMAKU_MERGE_WINDOW_SECONDS_MAX,
    );
}

fn normalize_recording_preferences(settings: &mut AppSettings) {
    settings.recording_auto_split_minutes = settings
        .recording_auto_split_minutes
        .min(RECORDING_AUTO_SPLIT_MINUTES_MAX);
    settings.ffmpeg_rw_timeout_seconds = settings
        .ffmpeg_rw_timeout_seconds
        .clamp(FFMPEG_RW_TIMEOUT_SECONDS_MIN, FFMPEG_RW_TIMEOUT_SECONDS_MAX);
    settings.ffmpeg_reconnect_delay_max_seconds =
        settings.ffmpeg_reconnect_delay_max_seconds.clamp(
            FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN,
            FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX,
        );
    settings.ffmpeg_hls_segment_retry_count = settings
        .ffmpeg_hls_segment_retry_count
        .min(FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX);

    let ass = &mut settings.recording_ass;
    ass.resolution_width = ass.resolution_width.clamp(
        RECORDING_ASS_RESOLUTION_WIDTH_MIN,
        RECORDING_ASS_RESOLUTION_WIDTH_MAX,
    );
    ass.resolution_height = ass.resolution_height.clamp(
        RECORDING_ASS_RESOLUTION_HEIGHT_MIN,
        RECORDING_ASS_RESOLUTION_HEIGHT_MAX,
    );
    ass.font_size = ass
        .font_size
        .clamp(RECORDING_ASS_FONT_SIZE_MIN, RECORDING_ASS_FONT_SIZE_MAX);
    ass.opacity_percent = ass.opacity_percent.min(100);
    ass.outline = normalize_ass_style_width(ass.outline);
    ass.shadow = normalize_ass_style_width(ass.shadow);
    ass.scroll_duration_seconds = ass.scroll_duration_seconds.clamp(
        RECORDING_ASS_SCROLL_DURATION_SECONDS_MIN,
        RECORDING_ASS_SCROLL_DURATION_SECONDS_MAX,
    );
    ass.display_area_percent = ass.display_area_percent.clamp(
        RECORDING_ASS_DISPLAY_AREA_PERCENT_MIN,
        RECORDING_ASS_DISPLAY_AREA_PERCENT_MAX,
    );
    if !matches!(ass.overflow_policy.as_str(), "overlap" | "drop" | "delay") {
        ass.overflow_policy =
            crate::models::settings::RecordingAssSettings::default().overflow_policy;
    }
    ass.max_delay_seconds = ass
        .max_delay_seconds
        .min(RECORDING_ASS_MAX_DELAY_SECONDS_MAX);
    ass.merge_window_seconds = ass
        .merge_window_seconds
        .min(RECORDING_ASS_MERGE_WINDOW_SECONDS_MAX);

    ass.font_name = ass
        .font_name
        .chars()
        .filter(|character| !character.is_control() && *character != ',')
        .take(RECORDING_ASS_FONT_NAME_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_owned();
    if ass.font_name.is_empty() {
        ass.font_name = crate::models::settings::RecordingAssSettings::default().font_name;
    }

    let mut seen = HashSet::new();
    ass.shield_rules.retain_mut(|rule| {
        *rule = rule
            .chars()
            .filter(|character| !character.is_control() || *character == '\t')
            .take(RECORDING_ASS_SHIELD_RULE_MAX_CHARS)
            .collect::<String>()
            .trim()
            .to_owned();
        !rule.is_empty() && seen.insert(rule.clone())
    });
    ass.shield_rules
        .truncate(RECORDING_ASS_SHIELD_RULE_MAX_COUNT);
}

fn normalize_ass_style_width(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    (value.clamp(0.0, RECORDING_ASS_STYLE_WIDTH_MAX) * 2.0).round() / 2.0
}

/// Load app settings from `settings_kv`, or return defaults only when no record exists.
pub fn get(conn: &Connection) -> AppResult<AppSettings> {
    Ok(get_with_status(conn)?.0)
}

fn decode_saved_settings(json: &str) -> AppResult<AppSettings> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|error| {
        AppError::new(
            "settings_schema_unsupported",
            format!("当前设置不是受支持的 rLive 2.0 格式: {error}"),
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        AppError::new("settings_schema_unsupported", "当前设置必须是 JSON object")
    })?;
    let default_value = serde_json::to_value(AppSettings::default()).map_err(|error| {
        AppError::new(
            "settings_schema_unsupported",
            format!("无法读取当前设置字段定义: {error}"),
        )
    })?;
    let default_object = default_value.as_object().ok_or_else(|| {
        AppError::new(
            "settings_schema_unsupported",
            "当前设置字段定义必须是 JSON object",
        )
    })?;
    if let Some(field) = default_object
        .keys()
        .find(|field| !object.contains_key(field.as_str()))
    {
        return Err(AppError::new(
            "settings_schema_unsupported",
            format!("当前设置缺少必填字段 {field}"),
        ));
    }
    serde_json::from_value(value).map_err(|error| {
        AppError::new(
            "settings_schema_unsupported",
            format!("当前设置不是受支持的 rLive 2.0 格式: {error}"),
        )
    })
}

/// Load settings along with whether a valid saved settings record exists.
///
/// The distinction lets the frontend choose device-specific first-run defaults
/// without treating them as an already saved preference.
pub fn get_with_status(conn: &Connection) -> AppResult<(AppSettings, bool)> {
    let mut stmt = conn
        .prepare("SELECT value FROM settings_kv WHERE key = ?1")
        .map_err(map_db_err)?;
    let raw: Option<String> = stmt
        .query_row(params![SETTINGS_KEY], |row| row.get(0))
        .optional()
        .map_err(map_db_err)?;

    let Some(json) = raw else {
        return Ok((AppSettings::default(), false));
    };
    let mut settings = decode_saved_settings(&json)?;
    normalize_site_preferences(&mut settings);
    normalize_danmaku_preferences(&mut settings);
    normalize_asr_preferences(&mut settings);
    normalize_recording_preferences(&mut settings);
    Ok((settings, true))
}

/// Persist full app settings under key `app_settings`.
pub fn set(conn: &Connection, settings: &AppSettings) -> AppResult<()> {
    let mut normalized = settings.clone();
    normalize_site_preferences(&mut normalized);
    normalize_danmaku_preferences(&mut normalized);
    normalize_asr_preferences(&mut normalized);
    normalize_recording_preferences(&mut normalized);
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
        assert_eq!(s.danmaku_font_stroke, 0.0);
        assert_eq!(s.danmaku_font_size, 20);
        assert_eq!(s.danmaku_speed, 100);
        assert_eq!(s.danmaku_area, 0.25);
        assert!(s.danmaku_filter_gifts);
        assert_eq!(s.danmaku_merge_window_seconds, 10);
        assert!(s.super_chat_enabled);
        assert_eq!(s.asr_font_size, 20);
        assert!(s.asr_vad_enabled);
        assert!(s.asr_punctuation_enabled);
        assert_eq!(s.asr_provider, "auto");
        assert!(s.asr_hotwords.is_empty());
        assert!(!s.asr_translation_enabled);
        assert_eq!(s.asr_translation_from, "auto");
        assert_eq!(s.asr_translation_to, "zh-CN");
        assert!(s.danmaku_shield_words.is_empty());
        assert!(s.proxy.is_none());
        assert!(s.recording_include_danmaku);
        assert_eq!(s.recording_ass.resolution_width, 1920);
        assert_eq!(s.recording_ass.font_size, 36);
        assert_eq!(s.recording_ass.opacity_percent, 80);
        assert_eq!(s.recording_ass.display_area_percent, 25);
    }

    #[test]
    fn set_and_get_roundtrip() {
        let conn = open_in_memory().unwrap();
        let s = AppSettings {
            theme: "dark".into(),
            proxy: Some("http://127.0.0.1:7890".into()),
            iptv_custom_m3u_url: Some("https://example.invalid/private.m3u".into()),
            danmaku_font_size: 22,
            ..AppSettings::default()
        };
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
        assert_eq!(get(&conn).unwrap().danmaku_merge_window_seconds, 1);

        // Zero is the explicit "merge off" value and must survive the boundary.
        settings.danmaku_merge_window_seconds = 0;
        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().danmaku_merge_window_seconds, 0);

        settings.danmaku_merge_window_seconds = 60;
        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().danmaku_merge_window_seconds, 30);
    }

    #[test]
    fn set_clamps_danmaku_speed() {
        let conn = open_in_memory().unwrap();
        let mut settings = AppSettings {
            danmaku_speed: 100,
            ..AppSettings::default()
        };

        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().danmaku_speed, 100);

        settings.danmaku_speed = 1;
        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().danmaku_speed, DANMAKU_SPEED_MIN);

        settings.danmaku_speed = 500;
        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().danmaku_speed, DANMAKU_SPEED_MAX);
    }

    #[test]
    fn set_normalizes_danmaku_font_stroke_to_half_pixels() {
        let conn = open_in_memory().unwrap();
        let mut settings = AppSettings {
            danmaku_font_stroke: 1.74,
            ..AppSettings::default()
        };

        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().danmaku_font_stroke, 1.5);

        settings.danmaku_font_stroke = 0.0;
        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().danmaku_font_stroke, 0.0);

        settings.danmaku_font_stroke = 0.1;
        set(&conn, &settings).unwrap();
        assert_eq!(
            get(&conn).unwrap().danmaku_font_stroke,
            DANMAKU_FONT_STROKE_MIN
        );

        settings.danmaku_font_stroke = 9.0;
        set(&conn, &settings).unwrap();
        assert_eq!(
            get(&conn).unwrap().danmaku_font_stroke,
            DANMAKU_FONT_STROKE_MAX
        );

        settings.danmaku_font_stroke = f32::NAN;
        set(&conn, &settings).unwrap();
        assert_eq!(
            get(&conn).unwrap().danmaku_font_stroke,
            DANMAKU_FONT_STROKE_DEFAULT
        );
    }

    #[test]
    fn set_clamps_ffmpeg_recording_options() {
        let conn = open_in_memory().unwrap();
        let settings = AppSettings {
            ffmpeg_rw_timeout_seconds: 1,
            ffmpeg_reconnect_delay_max_seconds: 100,
            ffmpeg_hls_segment_retry_count: 99,
            recording_auto_split_minutes: 10_000,
            ..AppSettings::default()
        };

        set(&conn, &settings).unwrap();
        let stored = get(&conn).unwrap();
        assert_eq!(stored.ffmpeg_rw_timeout_seconds, 3);
        assert_eq!(stored.ffmpeg_reconnect_delay_max_seconds, 60);
        assert_eq!(stored.ffmpeg_hls_segment_retry_count, 20);
        assert_eq!(stored.recording_auto_split_minutes, 24 * 60);
    }

    #[test]
    fn set_normalizes_recording_ass_options() {
        let conn = open_in_memory().unwrap();
        let mut settings = AppSettings::default();
        settings.recording_ass.resolution_width = 1;
        settings.recording_ass.resolution_height = 99_999;
        settings.recording_ass.font_name = "Bad,Font\n".into();
        settings.recording_ass.font_size = 999;
        settings.recording_ass.opacity_percent = 150;
        settings.recording_ass.outline = 1.74;
        settings.recording_ass.shadow = f32::NAN;
        settings.recording_ass.scroll_duration_seconds = 0;
        settings.recording_ass.display_area_percent = 0;
        settings.recording_ass.overflow_policy = "unsupported".into();
        settings.recording_ass.max_delay_seconds = 90;
        settings.recording_ass.merge_window_seconds = 90;
        settings.recording_ass.shield_rules =
            vec![" 广告 ".into(), "广告".into(), "".into(), "联系方式".into()];

        set(&conn, &settings).unwrap();
        let ass = get(&conn).unwrap().recording_ass;

        assert_eq!(ass.resolution_width, RECORDING_ASS_RESOLUTION_WIDTH_MIN);
        assert_eq!(ass.resolution_height, RECORDING_ASS_RESOLUTION_HEIGHT_MAX);
        assert_eq!(ass.font_name, "BadFont");
        assert_eq!(ass.font_size, RECORDING_ASS_FONT_SIZE_MAX);
        assert_eq!(ass.opacity_percent, 100);
        assert_eq!(ass.outline, 1.5);
        assert_eq!(ass.shadow, 0.0);
        assert_eq!(
            ass.scroll_duration_seconds,
            RECORDING_ASS_SCROLL_DURATION_SECONDS_MIN
        );
        assert_eq!(
            ass.display_area_percent,
            RECORDING_ASS_DISPLAY_AREA_PERCENT_MIN
        );
        assert_eq!(
            ass.merge_window_seconds,
            RECORDING_ASS_MERGE_WINDOW_SECONDS_MAX
        );
        assert_eq!(ass.overflow_policy, "delay");
        assert_eq!(ass.max_delay_seconds, RECORDING_ASS_MAX_DELAY_SECONDS_MAX);
        assert_eq!(ass.shield_rules, vec!["广告", "联系方式"]);

        settings.recording_ass.overflow_policy = "drop".into();
        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().recording_ass.overflow_policy, "drop");
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
    fn set_normalizes_asr_provider() {
        let conn = open_in_memory().unwrap();
        let mut settings = AppSettings {
            asr_provider: "unsupported".into(),
            ..AppSettings::default()
        };

        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().asr_provider, "auto");

        settings.asr_provider = "cuda".into();
        set(&conn, &settings).unwrap();
        assert_eq!(get(&conn).unwrap().asr_provider, "cuda");
    }

    #[test]
    fn set_normalizes_caption_translation_languages() {
        let conn = open_in_memory().unwrap();
        let mut settings = AppSettings {
            asr_translation_from: "unsupported".into(),
            asr_translation_to: "unsupported".into(),
            ..AppSettings::default()
        };

        set(&conn, &settings).unwrap();
        let normalized = get(&conn).unwrap();
        assert_eq!(normalized.asr_translation_from, "auto");
        assert_eq!(normalized.asr_translation_to, "zh-CN");

        settings.asr_translation_from = "en".into();
        settings.asr_translation_to = "en".into();
        set(&conn, &settings).unwrap();
        let normalized = get(&conn).unwrap();
        assert_eq!(normalized.asr_translation_from, "auto");
        assert_eq!(normalized.asr_translation_to, "en");

        settings.asr_translation_from = "auto".into();
        settings.asr_translation_to = "auto".into();
        set(&conn, &settings).unwrap();
        let normalized = get(&conn).unwrap();
        assert_eq!(normalized.asr_translation_from, "auto");
        assert_eq!(normalized.asr_translation_to, "auto");
    }

    #[test]
    fn set_keeps_one_platform_enabled_when_all_are_disabled() {
        let conn = open_in_memory().unwrap();
        let settings = AppSettings {
            default_site: "douyin".into(),
            disabled_site_ids: crate::sites::registry::all_meta()
                .into_iter()
                .map(|site| site.id.as_str().to_owned())
                .collect(),
            ..AppSettings::default()
        };

        set(&conn, &settings).unwrap();
        let (back, has_saved_settings) = get_with_status(&conn).unwrap();

        assert!(has_saved_settings);
        assert_eq!(back.default_site, "bilibili");
        assert!(!back.disabled_site_ids.iter().any(|site| site == "bilibili"));
    }

    #[test]
    fn rejects_corrupt_json_instead_of_resetting_defaults() {
        let conn = open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO settings_kv (key, value) VALUES (?1, ?2)",
            params![SETTINGS_KEY, "{not-valid-json"],
        )
        .unwrap();
        let error = get_with_status(&conn).unwrap_err();
        assert_eq!(error.code, "settings_schema_unsupported");
    }

    #[test]
    fn rejects_saved_settings_with_a_missing_current_field() {
        let conn = open_in_memory().unwrap();
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value.as_object_mut().unwrap().remove("asr_enabled");
        conn.execute(
            "INSERT INTO settings_kv (key, value) VALUES (?1, ?2)",
            params![SETTINGS_KEY, serde_json::to_string(&value).unwrap()],
        )
        .unwrap();

        let error = get_with_status(&conn).unwrap_err();
        assert_eq!(error.code, "settings_schema_unsupported");
        assert!(error.message.contains("asr_enabled"));
    }

    /// 溢出策略是在 2.4 之后加入的，旧记录缺少这两个字段时按默认值补齐，其余
    /// `recording_ass` 字段仍然必填。
    #[test]
    fn backfills_recording_ass_overflow_options_for_older_records() {
        let conn = open_in_memory().unwrap();
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let ass = value
            .get_mut("recording_ass")
            .and_then(serde_json::Value::as_object_mut)
            .unwrap();
        ass.remove("overflow_policy");
        ass.remove("max_delay_seconds");
        conn.execute(
            "INSERT INTO settings_kv (key, value) VALUES (?1, ?2)",
            params![SETTINGS_KEY, serde_json::to_string(&value).unwrap()],
        )
        .unwrap();

        let ass = get(&conn).unwrap().recording_ass;
        assert_eq!(ass.overflow_policy, "delay");
        assert_eq!(ass.max_delay_seconds, 5);
    }
}
