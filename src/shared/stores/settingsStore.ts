import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invokeCmd, isTauriUnavailableError } from "../api/tauri";
import { isMobileClient } from "../clientPlatform";
import {
  DEFAULT_SITE_ID,
  normalizeDisabledSiteIds,
  resolveEnabledSiteId,
  updateDisabledSiteIds,
} from "../siteId";
import {
  normalizeCaptionTranslationFrom,
  normalizeCaptionTranslationTo,
} from "../translation/languages";
import type {
  AppSettings,
  AsrProvider,
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
  RecordingAssOverflowPolicy,
  RecordingAssSettings,
  SiteId,
} from "../types/live";
import type { QualityLevel } from "../types/player";

export type ThemeMode = "system" | "light" | "dark";

export const DANMAKU_FONT_SIZE_DESKTOP_DEFAULT = 20;
export const DANMAKU_FONT_SIZE_MOBILE_DEFAULT = 16;
export const DANMAKU_OPACITY_DEFAULT = 0.8;
export const DANMAKU_FONT_STROKE_MIN = 0;
export const DANMAKU_FONT_STROKE_MAX = 1.5;
export const DANMAKU_FONT_STROKE_STEP = 0.5;
export const DANMAKU_FONT_STROKE_DEFAULT = 0;
export const DANMAKU_AREA_DEFAULT = 0.25;
export const DANMAKU_SPEED_MIN = 50;
export const DANMAKU_SPEED_MAX = 200;
export const DANMAKU_SPEED_DEFAULT = 100;

export function defaultDanmakuFontSize(mobile = isMobileClient()): number {
  return mobile ? DANMAKU_FONT_SIZE_MOBILE_DEFAULT : DANMAKU_FONT_SIZE_DESKTOP_DEFAULT;
}

/** 受支持滚动速度范围内的整数 CSS 像素每秒。 */
export function parseDanmakuSpeed(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return DANMAKU_SPEED_DEFAULT;
  return Math.min(DANMAKU_SPEED_MAX, Math.max(DANMAKU_SPEED_MIN, Math.round(numeric)));
}

/** 让播放器文字描边保持在支持的半像素步进上。 */
export function parseDanmakuFontStroke(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return DANMAKU_FONT_STROKE_DEFAULT;
  const stepped = Math.round(numeric / DANMAKU_FONT_STROKE_STEP) * DANMAKU_FONT_STROKE_STEP;
  return Math.min(DANMAKU_FONT_STROKE_MAX, Math.max(DANMAKU_FONT_STROKE_MIN, stepped));
}

// `settings_set` 写入完整对象。串行化写入使快速的房间控件
// （例如两次滑杆提交）不会乱序 resolve、
// 用过期快照覆盖最新设置。
let settingsWriteQueue: Promise<void> = Promise.resolve();
let danmakuSendSettingEpoch = 0;
let asrSettingEpoch = 0;

type SettingsGetResponse = {
  settings: AppSettings;
  has_saved_settings: boolean;
};

function isThemeMode(v: string): v is ThemeMode {
  return v === "system" || v === "light" || v === "dark";
}

function parseQualityLevel(value: unknown): QualityLevel {
  if (value === "mid" || value === "low" || value === "high") return value;
  return "high";
}

function parseAsrProvider(value: unknown): AsrProvider {
  return value === "cpu" || value === "cuda" ? value : "auto";
}

const ASR_FONT_SIZE_MIN = 12;
const ASR_FONT_SIZE_MAX = 48;
export const ASR_FONT_SIZE_DEFAULT = 20;
const ASR_WINDOW_SECONDS_MIN = 0.2;
const ASR_WINDOW_SECONDS_MAX = 1;
export const ASR_WINDOW_SECONDS_DEFAULT = 0.2;

/** 悬停直播间卡片播放静音直播预览的默认开关。 */
export const ROOM_CARD_PREVIEW_ENABLED_DEFAULT = true;

export const RECORDING_INCLUDE_DANMAKU_DEFAULT = true;
/**
 * 后台录制是无条件的，因此这是逐任务"离开页面后继续录制"开关的固定初始值，
 * 而不是存储的偏好。
 */
export const RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT = true;
export const RECORDING_AUTO_SPLIT_MINUTES_MIN = 0;
export const RECORDING_AUTO_SPLIT_MINUTES_MAX = 24 * 60;
export const RECORDING_AUTO_SPLIT_MINUTES_DEFAULT = 0;
export const RECORDING_MAX_CONCURRENT_MIN = 1;
export const RECORDING_MAX_CONCURRENT_MAX = 6;
export const RECORDING_MAX_CONCURRENT_DEFAULT = 4;
export const FFMPEG_RW_TIMEOUT_SECONDS_MIN = 3;
export const FFMPEG_RW_TIMEOUT_SECONDS_MAX = 60;
export const FFMPEG_RW_TIMEOUT_SECONDS_DEFAULT = 10;
export const FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN = 1;
export const FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX = 60;
export const FFMPEG_RECONNECT_DELAY_MAX_SECONDS_DEFAULT = 8;
export const FFMPEG_HLS_SEGMENT_RETRY_COUNT_MIN = 0;
export const FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX = 20;
export const FFMPEG_HLS_SEGMENT_RETRY_COUNT_DEFAULT = 5;
export const RECORDING_ASS_RESOLUTION_WIDTH_MIN = 320;
export const RECORDING_ASS_RESOLUTION_WIDTH_MAX = 7680;
export const RECORDING_ASS_RESOLUTION_HEIGHT_MIN = 240;
export const RECORDING_ASS_RESOLUTION_HEIGHT_MAX = 4320;
export const RECORDING_ASS_FONT_SIZE_MIN = 8;
export const RECORDING_ASS_FONT_SIZE_MAX = 160;
export const RECORDING_ASS_STYLE_WIDTH_MIN = 0;
export const RECORDING_ASS_STYLE_WIDTH_MAX = 4;
export const RECORDING_ASS_SCROLL_DURATION_SECONDS_MIN = 1;
export const RECORDING_ASS_SCROLL_DURATION_SECONDS_MAX = 60;
export const RECORDING_ASS_DISPLAY_AREA_PERCENT_MIN = 10;
export const RECORDING_ASS_DISPLAY_AREA_PERCENT_MAX = 100;
export const RECORDING_ASS_MAX_DELAY_SECONDS_MIN = 0;
export const RECORDING_ASS_MAX_DELAY_SECONDS_MAX = 30;
export const RECORDING_ASS_MERGE_WINDOW_SECONDS_MIN = 0;
export const RECORDING_ASS_MERGE_WINDOW_SECONDS_MAX = 30;

export const RECORDING_ASS_DEFAULT_SETTINGS: RecordingAssSettings = {
  resolution_width: 1920,
  resolution_height: 1080,
  font_name: "Microsoft YaHei",
  font_size: 36,
  opacity_percent: 80,
  outline: 2,
  shadow: 0,
  bold: false,
  scroll_duration_seconds: 12,
  display_area_percent: 25,
  overflow_policy: "delay",
  max_delay_seconds: 5,
  merge_window_seconds: 10,
  filter_gifts: true,
  show_super_chat: true,
  shield_rules: [],
  shield_regex: false,
};

function parseRecordingAssOverflowPolicy(value: unknown): RecordingAssOverflowPolicy {
  return value === "overlap" || value === "drop" || value === "delay"
    ? value
    : RECORDING_ASS_DEFAULT_SETTINGS.overflow_policy;
}

function parseBoundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function parseRecordingAssStyleWidth(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const stepped = Math.round(numeric * 2) / 2;
  return Math.min(RECORDING_ASS_STYLE_WIDTH_MAX, Math.max(RECORDING_ASS_STYLE_WIDTH_MIN, stepped));
}

function sanitizeRecordingAssText(value: string, allowNewline: boolean): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      if (code === 0x0a && allowNewline) return true;
      return code >= 0x20 && code !== 0x7f && character !== ",";
    })
    .join("");
}

export function normalizeRecordingAssSettings(value: RecordingAssSettings): RecordingAssSettings {
  const fontName = sanitizeRecordingAssText(value.font_name, false).trim().slice(0, 80);
  const shieldRules = Array.from(
    new Set(
      value.shield_rules
        .map((rule) => sanitizeRecordingAssText(rule, false).trim().slice(0, 200))
        .filter(Boolean),
    ),
  ).slice(0, 100);
  return {
    resolution_width: parseBoundedInteger(
      value.resolution_width,
      RECORDING_ASS_RESOLUTION_WIDTH_MIN,
      RECORDING_ASS_RESOLUTION_WIDTH_MAX,
      RECORDING_ASS_DEFAULT_SETTINGS.resolution_width,
    ),
    resolution_height: parseBoundedInteger(
      value.resolution_height,
      RECORDING_ASS_RESOLUTION_HEIGHT_MIN,
      RECORDING_ASS_RESOLUTION_HEIGHT_MAX,
      RECORDING_ASS_DEFAULT_SETTINGS.resolution_height,
    ),
    font_name: fontName || RECORDING_ASS_DEFAULT_SETTINGS.font_name,
    font_size: parseBoundedInteger(
      value.font_size,
      RECORDING_ASS_FONT_SIZE_MIN,
      RECORDING_ASS_FONT_SIZE_MAX,
      RECORDING_ASS_DEFAULT_SETTINGS.font_size,
    ),
    opacity_percent: parseBoundedInteger(
      value.opacity_percent,
      0,
      100,
      RECORDING_ASS_DEFAULT_SETTINGS.opacity_percent,
    ),
    outline: parseRecordingAssStyleWidth(value.outline, RECORDING_ASS_DEFAULT_SETTINGS.outline),
    shadow: parseRecordingAssStyleWidth(value.shadow, RECORDING_ASS_DEFAULT_SETTINGS.shadow),
    bold: value.bold,
    scroll_duration_seconds: parseBoundedInteger(
      value.scroll_duration_seconds,
      RECORDING_ASS_SCROLL_DURATION_SECONDS_MIN,
      RECORDING_ASS_SCROLL_DURATION_SECONDS_MAX,
      RECORDING_ASS_DEFAULT_SETTINGS.scroll_duration_seconds,
    ),
    display_area_percent: parseBoundedInteger(
      value.display_area_percent,
      RECORDING_ASS_DISPLAY_AREA_PERCENT_MIN,
      RECORDING_ASS_DISPLAY_AREA_PERCENT_MAX,
      RECORDING_ASS_DEFAULT_SETTINGS.display_area_percent,
    ),
    overflow_policy: parseRecordingAssOverflowPolicy(value.overflow_policy),
    max_delay_seconds: parseBoundedInteger(
      value.max_delay_seconds,
      RECORDING_ASS_MAX_DELAY_SECONDS_MIN,
      RECORDING_ASS_MAX_DELAY_SECONDS_MAX,
      RECORDING_ASS_DEFAULT_SETTINGS.max_delay_seconds,
    ),
    merge_window_seconds: parseBoundedInteger(
      value.merge_window_seconds,
      RECORDING_ASS_MERGE_WINDOW_SECONDS_MIN,
      RECORDING_ASS_MERGE_WINDOW_SECONDS_MAX,
      RECORDING_ASS_DEFAULT_SETTINGS.merge_window_seconds,
    ),
    filter_gifts: value.filter_gifts,
    show_super_chat: value.show_super_chat,
    shield_rules: shieldRules,
    shield_regex: value.shield_regex,
  };
}

export function parseFfmpegRwTimeoutSeconds(value: unknown): number {
  return parseBoundedInteger(
    value,
    FFMPEG_RW_TIMEOUT_SECONDS_MIN,
    FFMPEG_RW_TIMEOUT_SECONDS_MAX,
    FFMPEG_RW_TIMEOUT_SECONDS_DEFAULT,
  );
}

export function parseFfmpegReconnectDelayMaxSeconds(value: unknown): number {
  return parseBoundedInteger(
    value,
    FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN,
    FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX,
    FFMPEG_RECONNECT_DELAY_MAX_SECONDS_DEFAULT,
  );
}

export function parseFfmpegHlsSegmentRetryCount(value: unknown): number {
  return parseBoundedInteger(
    value,
    FFMPEG_HLS_SEGMENT_RETRY_COUNT_MIN,
    FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX,
    FFMPEG_HLS_SEGMENT_RETRY_COUNT_DEFAULT,
  );
}

export function parseRecordingAutoSplitMinutes(value: unknown): number {
  return parseBoundedInteger(
    value,
    RECORDING_AUTO_SPLIT_MINUTES_MIN,
    RECORDING_AUTO_SPLIT_MINUTES_MAX,
    RECORDING_AUTO_SPLIT_MINUTES_DEFAULT,
  );
}

export function parseRecordingMaxConcurrent(value: unknown): number {
  return parseBoundedInteger(
    value,
    RECORDING_MAX_CONCURRENT_MIN,
    RECORDING_MAX_CONCURRENT_MAX,
    RECORDING_MAX_CONCURRENT_DEFAULT,
  );
}

export function recordingPreferencesFromAppSettings(
  settings: Pick<
    AppSettings,
    | "recording_include_danmaku"
    | "recording_auto_split_minutes"
    | "recording_max_concurrent"
    | "ffmpeg_rw_timeout_seconds"
    | "ffmpeg_reconnect_delay_max_seconds"
    | "ffmpeg_hls_segment_retry_count"
    | "recording_ass"
  >,
) {
  return {
    recordingIncludeDanmaku: settings.recording_include_danmaku,
    recordingAutoSplitMinutes: parseRecordingAutoSplitMinutes(
      settings.recording_auto_split_minutes,
    ),
    recordingMaxConcurrent: parseRecordingMaxConcurrent(settings.recording_max_concurrent),
    ffmpegRwTimeoutSeconds: parseFfmpegRwTimeoutSeconds(settings.ffmpeg_rw_timeout_seconds),
    ffmpegReconnectDelayMaxSeconds: parseFfmpegReconnectDelayMaxSeconds(
      settings.ffmpeg_reconnect_delay_max_seconds,
    ),
    ffmpegHlsSegmentRetryCount: parseFfmpegHlsSegmentRetryCount(
      settings.ffmpeg_hls_segment_retry_count,
    ),
    recordingAssSettings: normalizeRecordingAssSettings(settings.recording_ass),
  };
}

/**
 * 本地热词列表的容量上限，与单条热词的最大长度。sherpa-onnx 把热词当作解码时的
 * 加权候选，过长的条目不可能被一整句识别命中，反而拖慢每一帧解码。
 */
export const ASR_HOTWORDS_MAX = 100;
export const ASR_HOTWORD_MAX_LENGTH = 80;

function parseAsrFontSize(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return ASR_FONT_SIZE_DEFAULT;
  return Math.min(ASR_FONT_SIZE_MAX, Math.max(ASR_FONT_SIZE_MIN, Math.round(numeric)));
}

/** 屏蔽用户列表的容量上限；到达后淘汰最早的条目。 */
export const DANMAKU_BLOCKED_USERS_MAX = 500;
/**
 * 设置里手输的单个屏蔽词或昵称的最大长度，两个列表共用同一口径。
 *
 * 取值对齐平台常规设置：B 站单条弹幕上限 20 字、虎牙 30 字（见
 * `danmaku/sending.ts`），屏蔽词按子串匹配，长过平台弹幕上限的条目永远
 * 不可能命中。仅约束手输：从弹幕列表点击屏蔽时按事件真实昵称写入，
 * 不受此上限限制，否则超长昵称会静默屏蔽失败。
 */
export const DANMAKU_SHIELD_ENTRY_MAX_LENGTH = 30;

/**
 * 屏蔽用户以弹幕事件携带的展示昵称为准。去空白、去空项、去重并按容量上限
 * 淘汰最早的条目。这里不做长度裁剪：昵称来自平台事件，长度由平台决定，
 * 按设置输入上限丢弃会让点击屏蔽对超长昵称静默失效。
 */
export function normalizeDanmakuBlockedUsers(users: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawUser of users) {
    if (typeof rawUser !== "string") continue;
    const user = rawUser.trim();
    if (!user || seen.has(user)) continue;
    seen.add(user);
    normalized.push(user);
  }
  return normalized.slice(Math.max(0, normalized.length - DANMAKU_BLOCKED_USERS_MAX));
}

export const DANMAKU_MERGE_WINDOW_SECONDS_MIN = 0;
export const DANMAKU_MERGE_WINDOW_SECONDS_MAX = 30;
export const DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT = 10;

/** 0..=30 内的整秒，0 表示关闭合并；非法取值回退 10s。 */
export function parseDanmakuMergeWindowSeconds(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT;
  return Math.min(
    DANMAKU_MERGE_WINDOW_SECONDS_MAX,
    Math.max(DANMAKU_MERGE_WINDOW_SECONDS_MIN, Math.round(numeric)),
  );
}

function parseAsrWindowSeconds(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return ASR_WINDOW_SECONDS_DEFAULT;
  const bounded = Math.min(ASR_WINDOW_SECONDS_MAX, Math.max(ASR_WINDOW_SECONDS_MIN, numeric));
  return Math.round(bounded * 10) / 10;
}

type SettingsState = {
  theme: ThemeMode;
  siteId: string;
  /** 平台停用项。 */
  disabledSiteIds: SiteId[];
  proxy: string | null;
  danmakuOpacity: number;
  danmakuFontStroke: number;
  danmakuFontSize: number;
  danmakuSpeed: number;
  danmakuArea: number;
  danmakuFilterGifts: boolean;
  danmakuMergeWindowSeconds: number;
  superChatEnabled: boolean;
  danmakuShieldWords: string[];
  /** 按展示昵称屏蔽的用户；列表与飘屏共用。 */
  danmakuBlockedUsers: string[];
  qualityLevel: QualityLevel;
  playbackSoftSwitchEnabled: boolean;
  /** 悬停浏览页直播间卡片时播放静音直播预览。 */
  roomCardPreviewEnabled: boolean;
  danmakuSendEnabled: boolean;
  /** 本地多平台发送权限同步到后端期间为 true。 */
  danmakuSendPending: boolean;
  asrEnabled: boolean;
  asrProvider: AsrProvider;
  asrVadEnabled: boolean;
  asrPunctuationEnabled: boolean;
  asrSpeakerDiarizationEnabled: boolean;
  asrHotwords: string[];
  asrWindowSeconds: number;
  asrFontSize: number;
  asrTranslationEnabled: boolean;
  asrTranslationFrom: CaptionTranslationSourceLanguage;
  asrTranslationTo: CaptionTranslationLanguage;
  /** 设备本地 ASR 选择同步到 Rust 后端期间为 true。 */
  asrPending: boolean;
  /**
   * 可发送账号 cookie 的仅内存 revision。它刻意不携带任何凭据数据；
   * 消费方只用它来在账号更新成功后失效缓存的权限检查。
   */
  danmakuCookieRevision: number;
  /** 设备本地自定义 IPTV M3U 地址；绝不纳入配置包。 */
  iptvCustomM3uUrl: string | null;
  recordingIncludeDanmaku: boolean;
  recordingAutoSplitMinutes: number;
  recordingMaxConcurrent: number;
  ffmpegRwTimeoutSeconds: number;
  ffmpegReconnectDelayMaxSeconds: number;
  ffmpegHlsSegmentRetryCount: number;
  recordingAssSettings: RecordingAssSettings;
  /** 后端加载完成或纯浏览器无后端兜底完成后为 true。 */
  hydratedFromBackend: boolean;
  /** 真实的 Tauri 设置/schema 错误会阻塞应用直至解决。 */
  settingsLoadError: unknown | null;
  setTheme: (theme: ThemeMode) => void;
  setSiteId: (siteId: string) => void;
  setSiteEnabled: (siteId: SiteId, enabled: boolean) => void;
  setProxy: (proxy: string | null) => void;
  setQualityLevel: (level: QualityLevel) => void;
  setPlaybackSoftSwitchEnabled: (enabled: boolean) => void;
  setRoomCardPreviewEnabled: (enabled: boolean) => void;
  setSuperChatEnabled: (enabled: boolean) => void;
  /** 屏蔽一个用户；已在列表中时为无操作。 */
  blockDanmakuUser: (user: string) => void;
  setDanmakuSendEnabled: (enabled: boolean) => void;
  setAsrEnabled: (enabled: boolean) => Promise<void>;
  setAsrProvider: (provider: AsrProvider) => Promise<void>;
  setAsrVadEnabled: (enabled: boolean) => Promise<void>;
  setAsrPunctuationEnabled: (enabled: boolean) => Promise<void>;
  setAsrSpeakerDiarizationEnabled: (enabled: boolean) => Promise<void>;
  setAsrHotwords: (hotwords: string[]) => Promise<void>;
  setAsrWindowSeconds: (seconds: number) => Promise<void>;
  setAsrTranslationEnabled: (enabled: boolean) => void;
  setAsrTranslationFrom: (from: CaptionTranslationSourceLanguage) => void;
  setAsrTranslationTo: (to: CaptionTranslationLanguage) => void;
  markDanmakuCookieChanged: () => void;
  setIptvCustomM3uUrl: (url: string | null) => void;
  setRecordingIncludeDanmaku: (enabled: boolean) => void;
  setRecordingAutoSplitMinutes: (minutes: number) => void;
  setRecordingMaxConcurrent: (count: number) => void;
  setFfmpegRwTimeoutSeconds: (seconds: number) => void;
  setFfmpegReconnectDelayMaxSeconds: (seconds: number) => void;
  setFfmpegHlsSegmentRetryCount: (count: number) => void;
  setRecordingAssSettings: (patch: Partial<RecordingAssSettings>) => void;
  applyFromBackend: (settings: AppSettings) => void;
  /** 从 Rust 加载设置；此后后端为事实来源。 */
  loadFromBackend: () => Promise<void>;
  /** 把当前设置（或部分合并）持久化到 Rust。 */
  persistToBackend: (patch?: Partial<AppSettings>) => Promise<void>;
};

const defaultSettings: AppSettings = {
  theme: "system",
  default_site: DEFAULT_SITE_ID,
  disabled_site_ids: [],
  proxy: null,
  danmaku_opacity: DANMAKU_OPACITY_DEFAULT,
  danmaku_font_stroke: DANMAKU_FONT_STROKE_DEFAULT,
  danmaku_font_size: defaultDanmakuFontSize(),
  danmaku_speed: DANMAKU_SPEED_DEFAULT,
  danmaku_area: DANMAKU_AREA_DEFAULT,
  danmaku_filter_gifts: true,
  danmaku_merge_window_seconds: DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
  super_chat_enabled: true,
  danmaku_shield_words: [],
  danmaku_blocked_users: [],
  quality_level: "high",
  playback_soft_switch_enabled: true,
  room_card_preview_enabled: ROOM_CARD_PREVIEW_ENABLED_DEFAULT,
  danmaku_send_enabled: false,
  asr_enabled: false,
  asr_provider: "auto",
  asr_vad_enabled: true,
  asr_punctuation_enabled: true,
  asr_speaker_diarization_enabled: false,
  asr_hotwords: [],
  asr_window_seconds: ASR_WINDOW_SECONDS_DEFAULT,
  asr_font_size: ASR_FONT_SIZE_DEFAULT,
  asr_translation_enabled: false,
  asr_translation_from: "auto",
  asr_translation_to: "zh-CN",
  iptv_custom_m3u_url: null,
  recording_include_danmaku: RECORDING_INCLUDE_DANMAKU_DEFAULT,
  recording_auto_split_minutes: RECORDING_AUTO_SPLIT_MINUTES_DEFAULT,
  recording_max_concurrent: RECORDING_MAX_CONCURRENT_DEFAULT,
  ffmpeg_rw_timeout_seconds: FFMPEG_RW_TIMEOUT_SECONDS_DEFAULT,
  ffmpeg_reconnect_delay_max_seconds: FFMPEG_RECONNECT_DELAY_MAX_SECONDS_DEFAULT,
  ffmpeg_hls_segment_retry_count: FFMPEG_HLS_SEGMENT_RETRY_COUNT_DEFAULT,
  recording_ass: RECORDING_ASS_DEFAULT_SETTINGS,
};

function toAppSettings(state: SettingsState): AppSettings {
  return {
    theme: state.theme,
    default_site: state.siteId,
    disabled_site_ids: state.disabledSiteIds,
    proxy: state.proxy,
    danmaku_opacity: state.danmakuOpacity,
    danmaku_font_stroke: state.danmakuFontStroke,
    danmaku_font_size: state.danmakuFontSize,
    danmaku_speed: state.danmakuSpeed,
    danmaku_area: state.danmakuArea,
    danmaku_filter_gifts: state.danmakuFilterGifts,
    danmaku_merge_window_seconds: state.danmakuMergeWindowSeconds,
    super_chat_enabled: state.superChatEnabled,
    danmaku_shield_words: state.danmakuShieldWords,
    danmaku_blocked_users: state.danmakuBlockedUsers,
    quality_level: state.qualityLevel,
    playback_soft_switch_enabled: state.playbackSoftSwitchEnabled,
    room_card_preview_enabled: state.roomCardPreviewEnabled,
    danmaku_send_enabled: state.danmakuSendEnabled,
    asr_enabled: state.asrEnabled,
    asr_provider: state.asrProvider,
    asr_vad_enabled: state.asrVadEnabled,
    asr_punctuation_enabled: state.asrPunctuationEnabled,
    asr_speaker_diarization_enabled: state.asrSpeakerDiarizationEnabled,
    asr_hotwords: state.asrHotwords,
    asr_window_seconds: state.asrWindowSeconds,
    asr_font_size: state.asrFontSize,
    asr_translation_enabled: state.asrTranslationEnabled,
    asr_translation_from: state.asrTranslationFrom,
    asr_translation_to: state.asrTranslationTo,
    iptv_custom_m3u_url: state.iptvCustomM3uUrl,
    recording_include_danmaku: state.recordingIncludeDanmaku,
    recording_auto_split_minutes: state.recordingAutoSplitMinutes,
    recording_max_concurrent: state.recordingMaxConcurrent,
    ffmpeg_rw_timeout_seconds: state.ffmpegRwTimeoutSeconds,
    ffmpeg_reconnect_delay_max_seconds: state.ffmpegReconnectDelayMaxSeconds,
    ffmpeg_hls_segment_retry_count: state.ffmpegHlsSegmentRetryCount,
    recording_ass: state.recordingAssSettings,
  };
}

/**
 * 生成"写入状态字段并把对应后端 settings key 持久化"的薄 setter。
 * 状态字段名与后端 key 常不同名（qualityLevel ↔ quality_level），两者都显式传入。
 */
function forwardedSetters(
  set: (partial: Partial<SettingsState>) => void,
  get: () => SettingsState,
) {
  const forward = <K extends keyof SettingsState, P extends keyof AppSettings>(
    stateKey: K,
    settingsKey: P,
  ) =>
    (value: SettingsState[K] & AppSettings[P]) => {
      set({ [stateKey]: value } as Partial<SettingsState>);
      void get().persistToBackend({ [settingsKey]: value } as Partial<AppSettings>);
    };
  return {
    setTheme: forward("theme", "theme"),
    setProxy: forward("proxy", "proxy"),
    setQualityLevel: forward("qualityLevel", "quality_level"),
    setPlaybackSoftSwitchEnabled: forward(
      "playbackSoftSwitchEnabled",
      "playback_soft_switch_enabled",
    ),
    setRoomCardPreviewEnabled: forward("roomCardPreviewEnabled", "room_card_preview_enabled"),
    setSuperChatEnabled: forward("superChatEnabled", "super_chat_enabled"),
    setAsrTranslationEnabled: forward("asrTranslationEnabled", "asr_translation_enabled"),
    setRecordingIncludeDanmaku: forward("recordingIncludeDanmaku", "recording_include_danmaku"),
  };
}

/**
 * 生成 ASR 子设置（provider、VAD、标点、说话人区分）的 setter：相等早退；
 * 持久化成功且 ASR 已启用时重启会话；失败仅当该写入仍是最新一次
 * （epoch 未被后续 ASR 写入递增）时回滚并重新持久化，finally 同理清
 * asrPending——否则先发请求的回滚会覆盖后发的新值。
 */
function asrSettingSetters(
  set: (partial: Partial<SettingsState>) => void,
  get: () => SettingsState,
) {
  const asrSetting = <K extends keyof SettingsState, P extends keyof AppSettings>(
    stateKey: K,
    settingsKey: P,
  ) =>
    async (value: SettingsState[K] & AppSettings[P]) => {
      const previous = get()[stateKey];
      if (value === previous) return;
      const epoch = ++asrSettingEpoch;
      set({ [stateKey]: value, asrPending: true } as Partial<SettingsState>);
      try {
        await get().persistToBackend({ [settingsKey]: value } as Partial<AppSettings>);
        if (get().asrEnabled) await invokeCmd("asr_enable");
      } catch (error) {
        if (epoch === asrSettingEpoch) {
          set({ [stateKey]: previous } as Partial<SettingsState>);
          await get().persistToBackend({ [settingsKey]: previous } as Partial<AppSettings>);
        }
        throw error;
      } finally {
        if (epoch === asrSettingEpoch) set({ asrPending: false });
      }
    };
  return {
    setAsrProvider: asrSetting("asrProvider", "asr_provider"),
    setAsrVadEnabled: asrSetting("asrVadEnabled", "asr_vad_enabled"),
    setAsrPunctuationEnabled: asrSetting("asrPunctuationEnabled", "asr_punctuation_enabled"),
    setAsrSpeakerDiarizationEnabled: asrSetting(
      "asrSpeakerDiarizationEnabled",
      "asr_speaker_diarization_enabled",
    ),
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: "system",
      siteId: DEFAULT_SITE_ID,
      disabledSiteIds: [],
      proxy: null,
      danmakuOpacity: DANMAKU_OPACITY_DEFAULT,
      danmakuFontStroke: DANMAKU_FONT_STROKE_DEFAULT,
      danmakuFontSize: defaultDanmakuFontSize(),
      danmakuSpeed: DANMAKU_SPEED_DEFAULT,
      danmakuArea: DANMAKU_AREA_DEFAULT,
      danmakuFilterGifts: true,
      danmakuMergeWindowSeconds: DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
      superChatEnabled: true,
      danmakuShieldWords: [],
      danmakuBlockedUsers: [],
      qualityLevel: "high",
      playbackSoftSwitchEnabled: true,
      roomCardPreviewEnabled: ROOM_CARD_PREVIEW_ENABLED_DEFAULT,
      danmakuSendEnabled: false,
      danmakuSendPending: false,
      asrEnabled: false,
      asrProvider: "auto",
      asrVadEnabled: true,
      asrPunctuationEnabled: true,
      asrSpeakerDiarizationEnabled: false,
      asrHotwords: [],
      asrWindowSeconds: ASR_WINDOW_SECONDS_DEFAULT,
      asrFontSize: ASR_FONT_SIZE_DEFAULT,
      asrTranslationEnabled: false,
      asrTranslationFrom: "auto",
      asrTranslationTo: "zh-CN",
      asrPending: false,
      danmakuCookieRevision: 0,
      iptvCustomM3uUrl: null,
      recordingIncludeDanmaku: RECORDING_INCLUDE_DANMAKU_DEFAULT,
      recordingAutoSplitMinutes: RECORDING_AUTO_SPLIT_MINUTES_DEFAULT,
      recordingMaxConcurrent: RECORDING_MAX_CONCURRENT_DEFAULT,
      ffmpegRwTimeoutSeconds: FFMPEG_RW_TIMEOUT_SECONDS_DEFAULT,
      ffmpegReconnectDelayMaxSeconds: FFMPEG_RECONNECT_DELAY_MAX_SECONDS_DEFAULT,
      ffmpegHlsSegmentRetryCount: FFMPEG_HLS_SEGMENT_RETRY_COUNT_DEFAULT,
      recordingAssSettings: RECORDING_ASS_DEFAULT_SETTINGS,
      hydratedFromBackend: false,
      settingsLoadError: null,
      ...forwardedSetters(set, get),
      ...asrSettingSetters(set, get),
      setSiteId: (siteId) => {
        const nextSiteId = resolveEnabledSiteId(siteId, get().disabledSiteIds);
        set({ siteId: nextSiteId });
        void get().persistToBackend({ default_site: nextSiteId });
      },
      setSiteEnabled: (siteId, enabled) => {
        const disabledSiteIds = updateDisabledSiteIds(get().disabledSiteIds, siteId, enabled);
        const nextSiteId = resolveEnabledSiteId(get().siteId, disabledSiteIds);
        set({ disabledSiteIds, siteId: nextSiteId });
        void get().persistToBackend({
          default_site: nextSiteId,
          disabled_site_ids: disabledSiteIds,
        });
      },
      blockDanmakuUser: (user) => {
        const name = user.trim();
        if (!name) return;
        const current = get().danmakuBlockedUsers;
        if (current.includes(name)) return;
        const danmakuBlockedUsers = normalizeDanmakuBlockedUsers([...current, name]);
        set({ danmakuBlockedUsers });
        void get().persistToBackend({ danmaku_blocked_users: danmakuBlockedUsers });
      },
      setDanmakuSendEnabled: (danmakuSendEnabled) => {
        const epoch = ++danmakuSendSettingEpoch;
        set({ danmakuSendEnabled, danmakuSendPending: true });
        void get()
          .persistToBackend({ danmaku_send_enabled: danmakuSendEnabled })
          .finally(() => {
            // 快速开关会排队两次完整设置写入。只有最新的完成才能清除同步标记，
            // 否则输入框可能在两次写入之间查到旧的后端取值。
            if (epoch === danmakuSendSettingEpoch) {
              set({ danmakuSendPending: false });
            }
          });
      },
      setAsrEnabled: async (asrEnabled) => {
        const epoch = ++asrSettingEpoch;
        const previous = get().asrEnabled;
        set({ asrEnabled, asrPending: true });
        try {
          await get().persistToBackend({ asr_enabled: asrEnabled });
          await invokeCmd(asrEnabled ? "asr_enable" : "asr_disable");
        } catch (error) {
          if (epoch === asrSettingEpoch) {
            set({ asrEnabled: previous });
            await get().persistToBackend({ asr_enabled: previous });
          }
          throw error;
        } finally {
          if (epoch === asrSettingEpoch) {
            set({ asrPending: false });
          }
        }
      },
      setAsrHotwords: async (asrHotwords) => {
        const normalized = Array.from(
          new Set(
            asrHotwords
              .map((word) => word.replace(/[\r\n\t]/g, " ").trim())
              .filter(
                (word) => word.length > 0 && Array.from(word).length <= ASR_HOTWORD_MAX_LENGTH,
              ),
          ),
        ).slice(0, ASR_HOTWORDS_MAX);
        const previous = get().asrHotwords;
        if (JSON.stringify(normalized) === JSON.stringify(previous)) return;
        const epoch = ++asrSettingEpoch;
        set({ asrHotwords: normalized, asrPending: true });
        try {
          await get().persistToBackend({ asr_hotwords: normalized });
          if (get().asrEnabled) await invokeCmd("asr_enable");
        } catch (error) {
          if (epoch === asrSettingEpoch) {
            set({ asrHotwords: previous });
            await get().persistToBackend({ asr_hotwords: previous });
          }
          throw error;
        } finally {
          if (epoch === asrSettingEpoch) set({ asrPending: false });
        }
      },
      setAsrWindowSeconds: async (seconds) => {
        const next = parseAsrWindowSeconds(seconds);
        const previous = get().asrWindowSeconds;
        if (next === previous) return;
        set({ asrWindowSeconds: next });
        try {
          await get().persistToBackend({ asr_window_seconds: next });
        } catch (error) {
          set({ asrWindowSeconds: previous });
          await get().persistToBackend({ asr_window_seconds: previous });
          throw error;
        }
      },
      setAsrTranslationFrom: (from) => {
        const normalized = normalizeCaptionTranslationFrom(from);
        const asrTranslationFrom =
          normalized !== "auto" && normalized === get().asrTranslationTo ? "auto" : normalized;
        set({ asrTranslationFrom });
        void get().persistToBackend({
          asr_translation_from: asrTranslationFrom,
        });
      },
      setAsrTranslationTo: (to) => {
        const asrTranslationTo = normalizeCaptionTranslationTo(to);
        const asrTranslationFrom =
          asrTranslationTo !== "auto" && get().asrTranslationFrom === asrTranslationTo
            ? "auto"
            : get().asrTranslationFrom;
        set({ asrTranslationFrom, asrTranslationTo });
        void get().persistToBackend({
          asr_translation_from: asrTranslationFrom,
          asr_translation_to: asrTranslationTo,
        });
      },
      markDanmakuCookieChanged: () => {
        // 刻意不持久化。它在应用重启后没有意义，
        // 且绝不能包含 Cookie 本身。
        set((state) => ({ danmakuCookieRevision: state.danmakuCookieRevision + 1 }));
      },
      setIptvCustomM3uUrl: (iptvCustomM3uUrl) => {
        const next = iptvCustomM3uUrl?.trim() || null;
        set({ iptvCustomM3uUrl: next });
        void get().persistToBackend({ iptv_custom_m3u_url: next });
      },
      setRecordingAutoSplitMinutes: (minutes) => {
        const recordingAutoSplitMinutes = parseRecordingAutoSplitMinutes(minutes);
        set({ recordingAutoSplitMinutes });
        void get().persistToBackend({
          recording_auto_split_minutes: recordingAutoSplitMinutes,
        });
      },
      setRecordingMaxConcurrent: (count) => {
        const recordingMaxConcurrent = parseRecordingMaxConcurrent(count);
        set({ recordingMaxConcurrent });
        void get().persistToBackend({ recording_max_concurrent: recordingMaxConcurrent });
      },
      setFfmpegRwTimeoutSeconds: (seconds) => {
        const ffmpegRwTimeoutSeconds = parseFfmpegRwTimeoutSeconds(seconds);
        set({ ffmpegRwTimeoutSeconds });
        void get().persistToBackend({ ffmpeg_rw_timeout_seconds: ffmpegRwTimeoutSeconds });
      },
      setFfmpegReconnectDelayMaxSeconds: (seconds) => {
        const ffmpegReconnectDelayMaxSeconds = parseFfmpegReconnectDelayMaxSeconds(seconds);
        set({ ffmpegReconnectDelayMaxSeconds });
        void get().persistToBackend({
          ffmpeg_reconnect_delay_max_seconds: ffmpegReconnectDelayMaxSeconds,
        });
      },
      setFfmpegHlsSegmentRetryCount: (count) => {
        const ffmpegHlsSegmentRetryCount = parseFfmpegHlsSegmentRetryCount(count);
        set({ ffmpegHlsSegmentRetryCount });
        void get().persistToBackend({
          ffmpeg_hls_segment_retry_count: ffmpegHlsSegmentRetryCount,
        });
      },
      setRecordingAssSettings: (patch) => {
        const recordingAssSettings = normalizeRecordingAssSettings({
          ...get().recordingAssSettings,
          ...patch,
        });
        set({ recordingAssSettings });
        void get().persistToBackend({ recording_ass: recordingAssSettings });
      },
      applyFromBackend: (settings) => {
        const theme = isThemeMode(settings.theme) ? settings.theme : "system";
        const disabledSiteIds = normalizeDisabledSiteIds(settings.disabled_site_ids);
        set({
          theme,
          siteId: resolveEnabledSiteId(settings.default_site, disabledSiteIds),
          disabledSiteIds,
          proxy: settings.proxy,
          danmakuOpacity: settings.danmaku_opacity,
          danmakuFontStroke: parseDanmakuFontStroke(settings.danmaku_font_stroke),
          danmakuFontSize: settings.danmaku_font_size,
          danmakuSpeed: parseDanmakuSpeed(settings.danmaku_speed),
          danmakuArea: settings.danmaku_area,
          danmakuFilterGifts: settings.danmaku_filter_gifts,
          danmakuMergeWindowSeconds: parseDanmakuMergeWindowSeconds(
            settings.danmaku_merge_window_seconds,
          ),
          superChatEnabled: settings.super_chat_enabled,
          danmakuShieldWords: settings.danmaku_shield_words,
          danmakuBlockedUsers: normalizeDanmakuBlockedUsers(settings.danmaku_blocked_users),
          qualityLevel: parseQualityLevel(settings.quality_level),
          playbackSoftSwitchEnabled: settings.playback_soft_switch_enabled,
          roomCardPreviewEnabled: settings.room_card_preview_enabled,
          danmakuSendEnabled: settings.danmaku_send_enabled,
          danmakuSendPending: false,
          asrEnabled: settings.asr_enabled,
          asrProvider: parseAsrProvider(settings.asr_provider),
          asrVadEnabled: settings.asr_vad_enabled,
          asrPunctuationEnabled: settings.asr_punctuation_enabled,
          asrSpeakerDiarizationEnabled: settings.asr_speaker_diarization_enabled,
          asrHotwords: settings.asr_hotwords,
          asrWindowSeconds: parseAsrWindowSeconds(settings.asr_window_seconds),
          asrFontSize: parseAsrFontSize(settings.asr_font_size),
          asrTranslationEnabled: settings.asr_translation_enabled,
          asrTranslationFrom: normalizeCaptionTranslationFrom(settings.asr_translation_from),
          asrTranslationTo: normalizeCaptionTranslationTo(settings.asr_translation_to),
          asrPending: false,
          iptvCustomM3uUrl: settings.iptv_custom_m3u_url?.trim() || null,
          ...recordingPreferencesFromAppSettings(settings),
          hydratedFromBackend: true,
          settingsLoadError: null,
        });
      },
      loadFromBackend: async () => {
        try {
          const result = await invokeCmd<SettingsGetResponse>("settings_get");
          const { settings, has_saved_settings: hasSavedSettings } = result;
          const disabledSiteIds = normalizeDisabledSiteIds(settings.disabled_site_ids);
          const siteId = resolveEnabledSiteId(settings.default_site, disabledSiteIds);

          get().applyFromBackend({
            ...settings,
            ...(hasSavedSettings ? {} : { danmaku_font_size: defaultDanmakuFontSize() }),
            default_site: siteId,
            disabled_site_ids: disabledSiteIds,
          });
        } catch (error) {
          // 纯浏览器开发没有 Rust 设置来源。真实的 Tauri schema 错误必须保持可观察，
          // 而不能变成默认值。
          if (isTauriUnavailableError(error)) {
            set({ hydratedFromBackend: true, settingsLoadError: null });
            return;
          }
          set({ hydratedFromBackend: false, settingsLoadError: error });
          throw error;
        }
      },
      persistToBackend: async (patch) => {
        // 避免在 loadFromBackend / applyFromBackend 完成前用本地默认值
        // 覆盖后端字段（proxy、danmaku_*）。
        if (!get().hydratedFromBackend) {
          return;
        }
        const current = toAppSettings(get());
        const next: AppSettings = { ...defaultSettings, ...current, ...patch };
        settingsWriteQueue = settingsWriteQueue
          .catch(() => {})
          .then(async () => {
            try {
              await invokeCmd<void>("settings_set", { settings: next });
            } catch {
              // 非 Tauri 环境下忽略。
            }
          });
        await settingsWriteQueue;
      },
    }),
    {
      name: "rlive-settings-v2",
      // 持久化首屏需要的少量 v2 本地状态；后端加载后覆盖。
      partialize: (s) => ({
        theme: s.theme,
        siteId: s.siteId,
        disabledSiteIds: s.disabledSiteIds,
      }),
    },
  ),
);
