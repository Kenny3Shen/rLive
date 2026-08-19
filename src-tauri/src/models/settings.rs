use serde::{Deserialize, Serialize};

/// Appearance, layout, and filtering used when a recorded danmaku sidecar is
/// converted to an ASS subtitle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RecordingAssSettings {
    pub resolution_width: u32,
    pub resolution_height: u32,
    /// Installed font family or PostScript name written into the ASS style.
    pub font_name: String,
    pub font_size: u32,
    /// Text opacity as a whole percentage, 0 ..= 100.
    pub opacity_percent: u32,
    pub outline: f32,
    pub shadow: f32,
    pub bold: bool,
    /// Time taken by one scrolling item to cross the canvas.
    pub scroll_duration_seconds: u32,
    /// Portion of the canvas height used by scrolling items, as a percentage.
    pub display_area_percent: u32,
    /// Fixed window used to merge duplicate chat messages; zero disables it.
    pub merge_window_seconds: u32,
    pub filter_gifts: bool,
    pub show_super_chat: bool,
    /// One literal substring or regular expression per item.
    pub shield_rules: Vec<String>,
    pub shield_regex: bool,
}

impl Default for RecordingAssSettings {
    fn default() -> Self {
        let font_name = if cfg!(target_os = "macos") {
            "PingFang SC"
        } else if cfg!(target_os = "linux") {
            "Noto Sans SC"
        } else {
            "Microsoft YaHei"
        };
        Self {
            resolution_width: 1920,
            resolution_height: 1080,
            font_name: font_name.into(),
            font_size: 36,
            opacity_percent: 80,
            outline: 2.0,
            shadow: 0.0,
            bold: false,
            scroll_duration_seconds: 12,
            display_area_percent: 25,
            merge_window_seconds: 10,
            filter_gifts: true,
            show_super_chat: true,
            shield_rules: Vec::new(),
            shield_regex: false,
        }
    }
}

/// Persisted application preferences (JSON in `settings_kv` key `app_settings`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppSettings {
    /// `system` | `light` | `dark`
    pub theme: String,
    pub default_site: String,
    /// Platform ids hidden from discovery and room navigation.
    pub disabled_site_ids: Vec<String>,
    /// e.g. `http://127.0.0.1:7890`
    pub proxy: Option<String>,
    /// 0.0 ..= 1.0
    pub danmaku_opacity: f32,
    /// Player danmaku text outline width in CSS pixels, 0.0 ..= 1.5.
    pub danmaku_font_stroke: f32,
    pub danmaku_font_size: u32,
    /// Scrolling danmaku speed in CSS pixels per second, 50 ..= 200.
    pub danmaku_speed: u32,
    /// Portion of the video height used by scrolling danmaku, 0.1 ..= 1.0.
    pub danmaku_area: f32,
    /// Sliding window used to merge duplicate chat messages, in seconds.
    /// Zero disables merging; normalized to 0 ..= 30 at the settings
    /// persistence boundary.
    pub danmaku_merge_window_seconds: u32,
    /// Whether gift-related messages should be hidden from the danmaku stream.
    pub danmaku_filter_gifts: bool,
    /// Whether Super Chat cards are enabled for the current site.
    pub super_chat_enabled: bool,
    pub danmaku_shield_words: Vec<String>,
    /// Preferred starting clarity: `high` | `mid` | `low` (Simple Live).
    pub quality_level: String,
    /// Same-protocol `switchURL` path. The frontend retains its hard-reload
    /// fallback for incompatible protocols and failed switches.
    pub playback_soft_switch_enabled: bool,
    /// Device-local permission for the user-operated single-message senders.
    /// It remains disabled until the user explicitly enables it in Settings and
    /// is not profile-imported. A Cookie and each platform's own validation
    /// are still required after this global consent is enabled.
    pub danmaku_send_enabled: bool,
    /// Device-local consent for the optional on-device ASR model. It remains
    /// disabled by default so first launch never downloads model data.
    pub asr_enabled: bool,
    /// Device-local ASR execution provider: `auto`, `cpu`, or `cuda`.
    pub asr_provider: String,
    /// Enable Zipformer's silence-based endpoint/VAD rules. Defaults to true;
    /// disabling it keeps only the maximum utterance length boundary.
    pub asr_vad_enabled: bool,
    /// Enable the optional CT-Transformer punctuation model. Defaults to true.
    pub asr_punctuation_enabled: bool,
    /// Optional endpoint-level speaker differentiation. This setting is
    /// device-local because enabling it downloads and loads an additional
    /// speaker embedding model.
    pub asr_speaker_diarization_enabled: bool,
    /// Device-local domain phrases (主播名、游戏名等), one phrase per item.
    pub asr_hotwords: Vec<String>,
    /// Device-local streaming PCM chunk interval in seconds, clamped to
    /// 0.2..=1.0 with one decimal place.
    pub asr_window_seconds: f32,
    /// Player subtitle font size in CSS pixels.
    pub asr_font_size: u32,
    /// Device-local consent for sending committed ASR captions to Google
    /// Translate. Disabled by default because subtitle text leaves the device.
    pub asr_translation_enabled: bool,
    /// Google Translate source language, or `auto` for language detection.
    pub asr_translation_from: String,
    /// Google Translate target language, or `auto` for automatic selection.
    pub asr_translation_to: String,
    /// Optional custom IPTV M3U address for this device.
    ///
    /// A playlist URL can identify a private source or include an access token,
    /// so it is intentionally excluded from profile export and import.
    pub iptv_custom_m3u_url: Option<String>,
    /// Keep a running recording alive in the background after leaving its page.
    ///
    /// Disabled by default: leaving a room or player while recording asks the
    /// user and stops the session, saving what was captured so far.
    pub recording_continue_after_leave: bool,
    /// Include the synchronized danmaku sidecar by default for live recordings.
    pub recording_include_danmaku: bool,
    /// Maximum duration of one FFmpeg recording bundle in minutes.
    /// Zero keeps one bundle until the task stops.
    pub recording_auto_split_minutes: u32,
    /// FFmpeg/libavformat blocking read timeout in seconds.
    pub ffmpeg_rw_timeout_seconds: u32,
    /// Maximum delay between FFmpeg network reconnect attempts in seconds.
    pub ffmpeg_reconnect_delay_max_seconds: u32,
    /// Number of retries for a failed HLS media segment.
    pub ffmpeg_hls_segment_retry_count: u32,
    pub recording_ass: RecordingAssSettings,
}

fn default_quality_level() -> String {
    "high".into()
}

fn default_playback_soft_switch_enabled() -> bool {
    true
}

fn default_danmaku_area() -> f32 {
    0.25
}

fn default_danmaku_speed() -> u32 {
    100
}

fn default_danmaku_font_stroke() -> f32 {
    0.0
}

fn default_danmaku_filter_gifts() -> bool {
    true
}

fn default_danmaku_merge_window_seconds() -> u32 {
    10
}

fn default_asr_font_size() -> u32 {
    20
}

fn default_asr_window_seconds() -> f32 {
    0.2
}

fn default_asr_provider() -> String {
    "auto".into()
}

fn default_asr_translation_from() -> String {
    "auto".into()
}

fn default_asr_translation_to() -> String {
    "zh-CN".into()
}

fn default_asr_punctuation_enabled() -> bool {
    true
}

fn default_asr_vad_enabled() -> bool {
    true
}

fn default_super_chat_enabled() -> bool {
    true
}

fn default_ffmpeg_rw_timeout_seconds() -> u32 {
    10
}

fn default_ffmpeg_reconnect_delay_max_seconds() -> u32 {
    8
}

fn default_ffmpeg_hls_segment_retry_count() -> u32 {
    5
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            default_site: "bilibili".into(),
            disabled_site_ids: Vec::new(),
            proxy: None,
            danmaku_opacity: 0.8,
            danmaku_font_stroke: default_danmaku_font_stroke(),
            danmaku_font_size: 20,
            danmaku_speed: default_danmaku_speed(),
            danmaku_area: default_danmaku_area(),
            danmaku_filter_gifts: default_danmaku_filter_gifts(),
            danmaku_merge_window_seconds: default_danmaku_merge_window_seconds(),
            super_chat_enabled: default_super_chat_enabled(),
            danmaku_shield_words: Vec::new(),
            quality_level: default_quality_level(),
            playback_soft_switch_enabled: default_playback_soft_switch_enabled(),
            danmaku_send_enabled: false,
            asr_enabled: false,
            asr_provider: default_asr_provider(),
            asr_vad_enabled: default_asr_vad_enabled(),
            asr_punctuation_enabled: default_asr_punctuation_enabled(),
            asr_speaker_diarization_enabled: false,
            asr_hotwords: Vec::new(),
            asr_window_seconds: default_asr_window_seconds(),
            asr_font_size: default_asr_font_size(),
            asr_translation_enabled: false,
            asr_translation_from: default_asr_translation_from(),
            asr_translation_to: default_asr_translation_to(),
            iptv_custom_m3u_url: None,
            recording_continue_after_leave: false,
            recording_include_danmaku: false,
            recording_auto_split_minutes: 0,
            ffmpeg_rw_timeout_seconds: default_ffmpeg_rw_timeout_seconds(),
            ffmpeg_reconnect_delay_max_seconds: default_ffmpeg_reconnect_delay_max_seconds(),
            ffmpeg_hls_segment_retry_count: default_ffmpeg_hls_segment_retry_count(),
            recording_ass: RecordingAssSettings::default(),
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
        assert_eq!(back.ffmpeg_rw_timeout_seconds, 10);
        assert_eq!(back.ffmpeg_reconnect_delay_max_seconds, 8);
        assert_eq!(back.ffmpeg_hls_segment_retry_count, 5);
        assert_eq!(back.recording_auto_split_minutes, 0);
        assert!(!v.contains("recording_auto_follow"));
        assert_eq!(back.recording_ass.resolution_width, 1920);
        assert_eq!(back.recording_ass.font_size, 36);
        assert_eq!(back.recording_ass.scroll_duration_seconds, 12);
        assert_eq!(back.recording_ass.display_area_percent, 25);
    }

    #[test]
    fn settings_require_ass_options() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value.as_object_mut().unwrap().remove("recording_ass");

        assert!(serde_json::from_value::<AppSettings>(value).is_err());
    }

    #[test]
    fn settings_reject_legacy_global_auto_follow() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value["recording_auto_follow"] = serde_json::json!(true);

        assert!(serde_json::from_value::<AppSettings>(value).is_err());
    }

    #[test]
    fn settings_reject_unknown_and_missing_fields() {
        let base = serde_json::to_value(AppSettings::default()).unwrap();
        let mut unknown_field = base.clone();
        unknown_field["motion_mode"] = serde_json::json!("full");
        let mut missing_field = base;
        missing_field
            .as_object_mut()
            .unwrap()
            .remove("danmaku_speed");

        for (case, value) in [
            ("unknown field", unknown_field),
            ("missing field", missing_field),
        ] {
            assert!(
                serde_json::from_value::<AppSettings>(value).is_err(),
                "accepted settings with {case}"
            );
        }
    }
}
