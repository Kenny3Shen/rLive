use serde::{Deserialize, Serialize};

/// 比引入它们的版本更早的记录里缺失、且必须按当前默认值回填的顶层设置字段。
///
/// 已保存设置与配置包对其余字段仍然严格必填：缺字段说明记录不是当前 schema，
/// 用默认值静默掩盖会丢掉用户的真实选择。只有纯新增的字段进入这份名单，
/// 因为旧记录不可能表达过对它的偏好。
pub const BACKFILLED_SETTINGS_FIELDS: &[&str] =
    &["room_card_preview_enabled", "danmaku_blocked_users"];

/// 录制弹幕伴生文件转换为 ASS 字幕时使用的外观、排版与过滤设置。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RecordingAssSettings {
    pub resolution_width: u32,
    pub resolution_height: u32,
    /// 写入 ASS 样式的已安装字体族名或 PostScript 名称。
    pub font_name: String,
    pub font_size: u32,
    /// 文本整体不透明度，百分比 0 ..= 100。
    pub opacity_percent: u32,
    pub outline: f32,
    pub shadow: f32,
    pub bold: bool,
    /// 单条滚动弹幕横穿画布所需的时间。
    pub scroll_duration_seconds: u32,
    /// 滚动弹幕占画布高度的比例，以百分比计。
    pub display_area_percent: u32,
    /// 车道耗尽策略：`overlap` | `drop` | `delay`。
    ///
    /// 为该选项出现之前的记录回填的默认值，因为其余字段仍为必填，
    /// 不能被默认值遮蔽。
    #[serde(default = "default_recording_ass_overflow_policy")]
    pub overflow_policy: String,
    /// `delay` 策略应用的时间偏移上限，单位为秒。
    #[serde(default = "default_recording_ass_max_delay_seconds")]
    pub max_delay_seconds: u32,
    /// 合并重复聊天消息的固定窗口；为零时禁用。
    pub merge_window_seconds: u32,
    pub filter_gifts: bool,
    pub show_super_chat: bool,
    /// 每项一个字面子串或正则表达式。
    pub shield_rules: Vec<String>,
    pub shield_regex: bool,
}

/// 录制回放是离线的，因此有界的时间偏移优于弹幕重叠或丢弃聊天内容。
fn default_recording_ass_overflow_policy() -> String {
    "delay".into()
}

fn default_recording_ass_max_delay_seconds() -> u32 {
    5
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
            overflow_policy: default_recording_ass_overflow_policy(),
            max_delay_seconds: default_recording_ass_max_delay_seconds(),
            merge_window_seconds: 10,
            filter_gifts: true,
            show_super_chat: true,
            shield_rules: Vec::new(),
            shield_regex: false,
        }
    }
}

/// 持久化的应用偏好设置（`settings_kv` 中 key 为 `app_settings` 的 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppSettings {
    /// 9
    /// 被拒绝的原生请求仍可能通过下方 execCommand 成功。
    pub theme: String,
    pub default_site: String,
    /// 从发现页与房间导航中隐藏的平台 id。
    pub disabled_site_ids: Vec<String>,
    /// 例如 `http://127.0.0.1:7890`
    pub proxy: Option<String>,
    /// 0.0 ..= 1.0
    pub danmaku_opacity: f32,
    /// 播放器弹幕描边宽度，CSS 像素，0.0 ..= 1.5。
    pub danmaku_font_stroke: f32,
    pub danmaku_font_size: u32,
    /// 滚动弹幕速度，CSS 像素每秒，50 ..= 200。
    pub danmaku_speed: u32,
    /// 滚动弹幕占视频高度的比例，0.1 ..= 1.0。
    pub danmaku_area: f32,
    /// 合并重复聊天消息的滑动窗口，单位为秒。
    /// 为零时禁用合并；
    /// 在设置持久化边界处归一化到 0 ..= 30。
    pub danmaku_merge_window_seconds: u32,
    /// 是否在弹幕流中隐藏与礼物相关的消息。
    pub danmaku_filter_gifts: bool,
    /// 当前站点是否启用 Super Chat 卡片。
    pub super_chat_enabled: bool,
    pub danmaku_shield_words: Vec<String>,
    /// 按展示昵称屏蔽的用户。平台事件缺少稳定用户 id，因此以昵称为准；
    /// 与屏蔽词一样是便携过滤偏好，随配置包导出导入。
    ///
    /// 比它更早的设置记录与配置包里没有它，serde default 补齐空列表；
    /// 必填校验把它列入 `BACKFILLED_SETTINGS_FIELDS`。
    #[serde(default)]
    pub danmaku_blocked_users: Vec<String>,
    /// 偏好的起始清晰度：`high` | `mid` | `low`。
    pub quality_level: String,
    /// 同协议的 `switchURL` 切换路径。前端对不兼容协议和切换失败
    /// 仍保留硬刷新兜底。
    pub playback_soft_switch_enabled: bool,
    /// 在浏览页悬停直播间卡片时播放静音直播预览。
    ///
    /// 该字段在 2.12.0 引入，因此比它更早保存的设置记录和配置包里没有它。
    /// 设置与 profile 的必填校验把它列入 `BACKFILLED_SETTINGS_FIELDS`，
    /// 由这里的 serde default 补齐，避免升级后整份设置不可读。
    #[serde(default = "default_room_card_preview_enabled")]
    pub room_card_preview_enabled: bool,
    /// 用户手动发送单条消息功能的本机权限开关。在用户于设置中显式启用之前
    /// 保持关闭，且不随配置导入。启用这项全局同意后，
    /// 发送仍需要 Cookie 以及各平台自身的校验。
    pub danmaku_send_enabled: bool,
    /// 可选端侧 ASR 模型的本机同意开关。默认关闭，
    /// 保证首次启动绝不下载模型数据。
    pub asr_enabled: bool,
    /// 本机 ASR 执行后端：`auto`、`cpu` 或 `cuda`。
    pub asr_provider: String,
    /// 启用 Zipformer 基于静音的端点/VAD 规则。默认开启；
    /// 关闭后仅保留最大语句长度边界。
    pub asr_vad_enabled: bool,
    /// 启用可选的 CT-Transformer 标点模型。默认开启。
    pub asr_punctuation_enabled: bool,
    /// 可选的端点级说话人区分。该设置仅存于本机，
    /// 因为启用它会下载并加载额外的说话人嵌入模型。
    pub asr_speaker_diarization_enabled: bool,
    /// Device-local domain phrases (主播名、游戏名等), one phrase per item.
    pub asr_hotwords: Vec<String>,
    /// 本机流式 PCM 分片间隔，单位为秒，钳制到 0.2..=1.0 并保留一位小数。
    pub asr_window_seconds: f32,
    /// 播放器字幕字号，CSS 像素。
    pub asr_font_size: u32,
    /// 把已定稿的 ASR 字幕发送到 Google 翻译的本机同意开关。
    /// 字幕文本会离开设备，因此默认关闭。
    pub asr_translation_enabled: bool,
    /// Google 翻译源语言，`auto` 表示自动检测。
    pub asr_translation_from: String,
    /// Google 翻译目标语言，`auto` 表示自动选择。
    pub asr_translation_to: String,
    /// 本设备的自定义 IPTV M3U 地址（可选）。
    ///
    /// 播放列表 URL 可能标识私有来源或包含访问 token，
    /// 因此刻意排除在配置导出/导入之外。
    pub iptv_custom_m3u_url: Option<String>,
    /// 仅为读取后台录制成为无条件行为之前写入的设置而保留。
    /// 现在录制在其页面被离开后总是继续。
    #[serde(default, rename = "recording_continue_after_leave", skip_serializing)]
    pub legacy_recording_continue_after_leave: bool,
    /// 直播录制默认包含同步的弹幕伴生文件。
    pub recording_include_danmaku: bool,
    /// 单个 FFmpeg 录制分卷的最大时长，单位为分钟。
    /// 为零表示任务停止前一直使用同一个分卷。
    pub recording_auto_split_minutes: u32,
    /// FFmpeg/libavformat 阻塞读取超时，单位为秒。
    pub ffmpeg_rw_timeout_seconds: u32,
    /// FFmpeg 网络重连尝试之间的最大延迟，单位为秒。
    pub ffmpeg_reconnect_delay_max_seconds: u32,
    /// 失败的 HLS 媒体分片的重试次数。
    pub ffmpeg_hls_segment_retry_count: u32,
    pub recording_ass: RecordingAssSettings,
}

fn default_quality_level() -> String {
    "high".into()
}

fn default_playback_soft_switch_enabled() -> bool {
    true
}

fn default_room_card_preview_enabled() -> bool {
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
            danmaku_blocked_users: Vec::new(),
            quality_level: default_quality_level(),
            playback_soft_switch_enabled: default_playback_soft_switch_enabled(),
            room_card_preview_enabled: default_room_card_preview_enabled(),
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
            legacy_recording_continue_after_leave: false,
            recording_include_danmaku: true,
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
        assert!(back.recording_include_danmaku);
        assert_eq!(back.recording_auto_split_minutes, 0);
        assert!(back.room_card_preview_enabled);
        assert!(back.danmaku_shield_words.is_empty());
        assert!(back.danmaku_blocked_users.is_empty());
        assert!(!v.contains("recording_auto_follow"));
        assert!(!back.legacy_recording_continue_after_leave);
        assert!(!v.contains("recording_continue_after_leave"));
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
    fn settings_accept_and_drop_legacy_continue_after_leave() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value["recording_continue_after_leave"] = serde_json::json!(true);

        let settings: AppSettings = serde_json::from_value(value).unwrap();

        assert!(settings.legacy_recording_continue_after_leave);
        assert!(
            !serde_json::to_value(settings)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("recording_continue_after_leave")
        );
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
