use serde::{Deserialize, Serialize};

/// Persisted application preferences (JSON in `settings_kv` key `app_settings`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppSettings {
    /// `system` | `light` | `dark`
    pub theme: String,
    pub default_site: String,
    /// Platform ids hidden from discovery and room navigation.
    ///
    /// Legacy settings omit this field, which intentionally means every
    /// bundled platform remains enabled.
    #[serde(default)]
    pub disabled_site_ids: Vec<String>,
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
    /// Hide gift notices in the room chat list and floating danmaku.
    #[serde(default)]
    pub danmaku_filter_gifts: bool,
    /// Show supported-platform Super Chat cards over the player.
    #[serde(default = "default_super_chat_enabled")]
    pub super_chat_enabled: bool,
    pub danmaku_shield_words: Vec<String>,
    /// Preferred starting clarity: `high` | `mid` | `low` (Simple Live).
    #[serde(default = "default_quality_level")]
    pub quality_level: String,
    /// Device-local permission for the user-operated single-message senders.
    /// It remains disabled until the user explicitly enables it in Settings and
    /// is not profile-imported. A Cookie and each platform's own validation
    /// are still required after this global consent is enabled.
    #[serde(default)]
    pub danmaku_send_enabled: bool,
    /// Optional custom IPTV M3U address for this device.
    ///
    /// A playlist URL can identify a private source or include an access token,
    /// so it is intentionally excluded from profile export and import.
    #[serde(default)]
    pub iptv_custom_m3u_url: Option<String>,
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

fn default_super_chat_enabled() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            default_site: "bilibili".into(),
            disabled_site_ids: Vec::new(),
            proxy: None,
            danmaku_opacity: 1.0,
            danmaku_font_size: 18,
            danmaku_speed: 8,
            danmaku_area: default_danmaku_area(),
            danmaku_line_count: 0,
            danmaku_font_weight: default_danmaku_font_weight(),
            danmaku_filter_repeats: default_danmaku_filter_repeats(),
            danmaku_filter_gifts: false,
            super_chat_enabled: default_super_chat_enabled(),
            danmaku_shield_words: Vec::new(),
            quality_level: default_quality_level(),
            danmaku_send_enabled: false,
            iptv_custom_m3u_url: None,
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
        // A former Bilibili-only consent must not become the new shared
        // Bilibili/Douyu/Huya write permission during deserialization.
        let legacy = r#"{
          "theme": "system",
          "default_site": "bilibili",
          "proxy": null,
          "danmaku_opacity": 1.0,
          "danmaku_font_size": 18,
          "danmaku_speed": 8,
          "danmaku_shield_words": [],
          "mpv_path": "/legacy/mpv",
          "bilibili_danmaku_send_enabled": true
        }"#;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();

        assert_eq!(settings.danmaku_area, 0.9);
        assert_eq!(settings.danmaku_line_count, 0);
        assert_eq!(settings.danmaku_font_weight, 600);
        assert!(settings.danmaku_filter_repeats);
        assert!(!settings.danmaku_filter_gifts);
        assert!(settings.super_chat_enabled);
        assert!(!settings.danmaku_send_enabled);
        assert!(settings.iptv_custom_m3u_url.is_none());
        assert!(settings.disabled_site_ids.is_empty());
    }

    #[test]
    fn legacy_custom_model_path_is_ignored() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value.as_object_mut().unwrap().insert(
            "asr_model_path".into(),
            serde_json::json!("C:\\models\\old.bin"),
        );

        let settings: AppSettings = serde_json::from_value(value).unwrap();

        assert_eq!(settings, AppSettings::default());
    }
}
