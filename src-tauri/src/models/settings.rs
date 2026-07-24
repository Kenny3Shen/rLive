use serde::{Deserialize, Serialize};

/// Persisted application preferences (JSON in `settings_kv` key `app_settings`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppSettings {
    /// `system` | `light` | `dark`
    pub theme: String,
    pub default_site: String,
    /// e.g. `http://127.0.0.1:7890`
    pub proxy: Option<String>,
    /// 0.0 ..= 1.0
    pub danmaku_opacity: f32,
    pub danmaku_font_size: u32,
    pub danmaku_speed: u32,
    /// Portion of the video height used by scrolling danmaku, 0.1 ..= 1.0.
    #[serde(default = "default_danmaku_area")]
    pub danmaku_area: f32,
    /// Maximum scrolling lanes. `0` chooses a suitable count automatically.
    #[serde(default)]
    pub danmaku_line_count: u32,
    /// Canvas font weight (400 / 500 / 600 / 700).
    #[serde(default = "default_danmaku_font_weight")]
    pub danmaku_font_weight: u16,
    /// Suppress consecutive duplicate chat messages in the visual clients.
    #[serde(default = "default_danmaku_filter_repeats")]
    pub danmaku_filter_repeats: bool,
    pub danmaku_shield_words: Vec<String>,
    pub mpv_path: Option<String>,
    /// Preferred starting clarity: `high` | `mid` | `low` (Simple Live).
    #[serde(default = "default_quality_level")]
    pub quality_level: String,
}

fn default_quality_level() -> String {
    "high".into()
}

fn default_danmaku_area() -> f32 {
    0.9
}

fn default_danmaku_font_weight() -> u16 {
    600
}

fn default_danmaku_filter_repeats() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            default_site: "bilibili".into(),
            proxy: None,
            danmaku_opacity: 1.0,
            danmaku_font_size: 18,
            danmaku_speed: 8,
            danmaku_area: default_danmaku_area(),
            danmaku_line_count: 0,
            danmaku_font_weight: default_danmaku_font_weight(),
            danmaku_filter_repeats: default_danmaku_filter_repeats(),
            danmaku_shield_words: Vec::new(),
            mpv_path: None,
            quality_level: default_quality_level(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_roundtrip() {
        let s = AppSettings::default();
        let v = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&v).unwrap();
        assert_eq!(back.default_site, "bilibili");
    }

    #[test]
    fn legacy_settings_receive_new_danmaku_defaults() {
        let legacy = r#"{
          "theme": "system",
          "default_site": "bilibili",
          "proxy": null,
          "danmaku_opacity": 1.0,
          "danmaku_font_size": 18,
          "danmaku_speed": 8,
          "danmaku_shield_words": [],
          "mpv_path": null
        }"#;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();

        assert_eq!(settings.danmaku_area, 0.9);
        assert_eq!(settings.danmaku_line_count, 0);
        assert_eq!(settings.danmaku_font_weight, 600);
        assert!(settings.danmaku_filter_repeats);
    }
}
