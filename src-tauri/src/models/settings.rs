use serde::{Deserialize, Serialize};

/// Persisted application preferences (JSON in `settings_kv` key `app_settings`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppSettings {
    /// `system` | `light` | `dark`
    pub theme: String,
    /// Legacy compatibility field; normalized to `full` at the settings boundary.
    #[serde(default = "default_motion_mode")]
    pub motion_mode: String,
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
    /// Player danmaku text outline width in CSS pixels, 0.5 ..= 2.5.
    #[serde(default = "default_danmaku_font_stroke")]
    pub danmaku_font_stroke: f32,
    pub danmaku_font_size: u32,
    /// Scrolling danmaku speed in CSS pixels per second, 50 ..= 200.
    #[serde(default = "default_danmaku_speed")]
    pub danmaku_speed: u32,
    /// Portion of the video height used by scrolling danmaku, 0.1 ..= 1.0.
    #[serde(default = "default_danmaku_area")]
    pub danmaku_area: f32,
    /// Sliding window used to merge duplicate chat messages, in seconds.
    /// Zero disables merging; normalized to 0 ..= 30 at the settings
    /// persistence boundary.
    #[serde(default = "default_danmaku_merge_window_seconds")]
    pub danmaku_merge_window_seconds: u32,
    /// Whether gift-related messages should be hidden from the danmaku stream.
    #[serde(default = "default_danmaku_filter_gifts")]
    pub danmaku_filter_gifts: bool,
    /// Whether Super Chat cards are enabled for the current site.
    #[serde(default = "default_super_chat_enabled")]
    pub super_chat_enabled: bool,
    pub danmaku_shield_words: Vec<String>,
    /// Preferred starting clarity: `high` | `mid` | `low` (Simple Live).
    #[serde(default = "default_quality_level")]
    pub quality_level: String,
    /// Probe playback candidates through the configured proxy and rank healthy
    /// sources before automatic failover.
    #[serde(default = "default_playback_smart_line_selection")]
    pub playback_smart_line_selection: bool,
    /// Same-protocol `switchURL` path. The frontend retains its hard-reload
    /// fallback for incompatible protocols and failed switches.
    #[serde(default = "default_playback_soft_switch_enabled")]
    pub playback_soft_switch_enabled: bool,
    /// Switch to another ranked source after sustained playback stalling.
    #[serde(default = "default_playback_stall_auto_switch_enabled")]
    pub playback_stall_auto_switch_enabled: bool,
    /// Device-local permission for the user-operated single-message senders.
    /// It remains disabled until the user explicitly enables it in Settings and
    /// is not profile-imported. A Cookie and each platform's own validation
    /// are still required after this global consent is enabled.
    #[serde(default)]
    pub danmaku_send_enabled: bool,
    /// Device-local consent for the optional on-device ASR model. It remains
    /// disabled by default so first launch never downloads model data.
    #[serde(default)]
    pub asr_enabled: bool,
    /// Device-local ASR execution provider: `auto`, `cpu`, or `cuda`.
    #[serde(default = "default_asr_provider")]
    pub asr_provider: String,
    /// Enable Zipformer's silence-based endpoint/VAD rules. Defaults to true;
    /// disabling it keeps only the maximum utterance length boundary.
    #[serde(default = "default_asr_vad_enabled")]
    pub asr_vad_enabled: bool,
    /// Enable the optional CT-Transformer punctuation model. Defaults to true.
    #[serde(default = "default_asr_punctuation_enabled")]
    pub asr_punctuation_enabled: bool,
    /// Optional endpoint-level speaker differentiation. This setting is
    /// device-local because enabling it downloads and loads an additional
    /// speaker embedding model.
    #[serde(default)]
    pub asr_speaker_diarization_enabled: bool,
    /// Device-local domain phrases (主播名、游戏名等), one phrase per item.
    #[serde(default)]
    pub asr_hotwords: Vec<String>,
    /// Device-local streaming PCM chunk interval in seconds, clamped to
    /// 0.2..=1.0 with one decimal place. The persisted field name is retained
    /// for compatibility with existing settings records.
    #[serde(default = "default_asr_window_seconds")]
    pub asr_window_seconds: f32,
    /// Player subtitle font size in CSS pixels.
    #[serde(default = "default_asr_font_size")]
    pub asr_font_size: u32,
    /// Device-local consent for sending committed ASR captions to Google
    /// Translate. Disabled by default because subtitle text leaves the device.
    #[serde(default)]
    pub asr_translation_enabled: bool,
    /// Google Translate source language, or `auto` for language detection.
    #[serde(default = "default_asr_translation_from")]
    pub asr_translation_from: String,
    /// Google Translate target language, or `auto` for automatic selection.
    #[serde(default = "default_asr_translation_to")]
    pub asr_translation_to: String,
    /// Optional custom IPTV M3U address for this device.
    ///
    /// A playlist URL can identify a private source or include an access token,
    /// so it is intentionally excluded from profile export and import.
    #[serde(default)]
    pub iptv_custom_m3u_url: Option<String>,
    /// Keep a running recording alive in the background after leaving its page.
    ///
    /// Disabled by default: leaving a room or player while recording asks the
    /// user and stops the session, saving what was captured so far.
    #[serde(default)]
    pub recording_continue_after_leave: bool,
    /// Include the synchronized danmaku sidecar by default for live recordings.
    #[serde(default)]
    pub recording_include_danmaku: bool,
    /// FFmpeg/libavformat blocking read timeout in seconds.
    #[serde(default = "default_ffmpeg_rw_timeout_seconds")]
    pub ffmpeg_rw_timeout_seconds: u32,
    /// Maximum delay between FFmpeg network reconnect attempts in seconds.
    #[serde(default = "default_ffmpeg_reconnect_delay_max_seconds")]
    pub ffmpeg_reconnect_delay_max_seconds: u32,
    /// Number of retries for a failed HLS media segment.
    #[serde(default = "default_ffmpeg_hls_segment_retry_count")]
    pub ffmpeg_hls_segment_retry_count: u32,
    /// Legacy compatibility field. The client now performs one startup probe
    /// and no longer schedules periodic checks, but old profiles still carry
    /// this value and must remain deserializable.
    #[serde(default = "default_iptv_availability_auto_check")]
    pub iptv_availability_auto_check: bool,
    /// Legacy compatibility field retained for old settings records.
    #[serde(default = "default_iptv_availability_auto_check_interval_hours")]
    pub iptv_availability_auto_check_interval_hours: u32,
}

fn default_quality_level() -> String {
    "high".into()
}

fn default_motion_mode() -> String {
    "full".into()
}

fn default_playback_smart_line_selection() -> bool {
    true
}

fn default_playback_soft_switch_enabled() -> bool {
    true
}

fn default_playback_stall_auto_switch_enabled() -> bool {
    true
}

fn default_iptv_availability_auto_check() -> bool {
    true
}

fn default_iptv_availability_auto_check_interval_hours() -> u32 {
    1
}

fn default_danmaku_area() -> f32 {
    0.25
}

fn default_danmaku_speed() -> u32 {
    100
}

fn default_danmaku_font_stroke() -> f32 {
    2.5
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
            motion_mode: default_motion_mode(),
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
            playback_smart_line_selection: default_playback_smart_line_selection(),
            playback_soft_switch_enabled: default_playback_soft_switch_enabled(),
            playback_stall_auto_switch_enabled: default_playback_stall_auto_switch_enabled(),
            danmaku_send_enabled: false,
            asr_enabled: false,
            asr_provider: default_asr_provider(),
            asr_vad_enabled: true,
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
            ffmpeg_rw_timeout_seconds: default_ffmpeg_rw_timeout_seconds(),
            ffmpeg_reconnect_delay_max_seconds: default_ffmpeg_reconnect_delay_max_seconds(),
            ffmpeg_hls_segment_retry_count: default_ffmpeg_hls_segment_retry_count(),
            iptv_availability_auto_check: true,
            iptv_availability_auto_check_interval_hours: 1,
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
        assert_eq!(back.motion_mode, "full");
        assert_eq!(back.ffmpeg_rw_timeout_seconds, 10);
        assert_eq!(back.ffmpeg_reconnect_delay_max_seconds, 8);
        assert_eq!(back.ffmpeg_hls_segment_retry_count, 5);
    }

    #[test]
    fn legacy_settings_ignore_removed_fields_and_receive_new_danmaku_defaults() {
        // A former Bilibili-only consent must not become the new shared
        // Bilibili/Douyu/Huya write permission during deserialization.
        let legacy = r#"{
          "theme": "system",
          "default_site": "bilibili",
          "proxy": null,
          "danmaku_opacity": 0.8,
          "danmaku_font_size": 18,
          "danmaku_font_weight": 400,
          "danmaku_line_count": 8,
          "super_chat_opacity": 0.6,
          "danmaku_shield_words": [],
          "mpv_path": "/legacy/mpv",
          "bilibili_danmaku_send_enabled": true
        }"#;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();
        let serialized = serde_json::to_value(&settings).unwrap();

        assert_eq!(serialized.get("danmaku_speed").unwrap(), 100);
        assert!(serialized.get("super_chat_opacity").is_none());
        assert!(serialized.get("danmaku_line_count").is_none());
        assert!(serialized.get("danmaku_filter_repeats").is_none());
        assert!(serialized.get("danmaku_font_weight").is_none());
        assert_eq!(settings.danmaku_area, 0.25);
        assert_eq!(settings.danmaku_speed, 100);
        assert_eq!(settings.motion_mode, "full");
        assert_eq!(settings.danmaku_font_stroke, 2.5);
        assert!(settings.danmaku_filter_gifts);
        assert_eq!(settings.danmaku_merge_window_seconds, 10);
        assert!(settings.super_chat_enabled);
        assert!(!settings.danmaku_send_enabled);
        assert!(settings.playback_smart_line_selection);
        assert!(settings.playback_soft_switch_enabled);
        assert!(settings.playback_stall_auto_switch_enabled);
        assert!(!settings.asr_enabled);
        assert_eq!(settings.asr_provider, "auto");
        assert!(settings.asr_vad_enabled);
        assert!(settings.asr_punctuation_enabled);
        assert!(!settings.asr_speaker_diarization_enabled);
        assert!(settings.asr_hotwords.is_empty());
        assert_eq!(settings.asr_window_seconds, 0.2);
        assert!(settings.iptv_custom_m3u_url.is_none());
        assert!(settings.iptv_availability_auto_check);
        assert_eq!(settings.iptv_availability_auto_check_interval_hours, 1);
        assert!(settings.disabled_site_ids.is_empty());
    }
}
