import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invokeCmd } from "../api/tauri";
import { isMobileClient } from "../clientPlatform";
import {
  DEFAULT_SITE_ID,
  normalizeDisabledSiteIds,
  resolveEnabledSiteId,
  resolveStartupSiteId,
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
  SiteId,
} from "../types/live";
import type { QualityLevel } from "../types/player";

export type ThemeMode = "system" | "light" | "dark";

export const DANMAKU_FONT_SIZE_DESKTOP_DEFAULT = 18;
export const DANMAKU_FONT_SIZE_MOBILE_DEFAULT = 14;
export const DANMAKU_OPACITY_DEFAULT = 0.8;
export const DANMAKU_AREA_DEFAULT = 0.25;
export const DANMAKU_SPEED_MIN = 50;
export const DANMAKU_SPEED_MAX = 200;
export const DANMAKU_SPEED_DEFAULT = 100;

export function defaultDanmakuFontSize(mobile = isMobileClient()): number {
  return mobile ? DANMAKU_FONT_SIZE_MOBILE_DEFAULT : DANMAKU_FONT_SIZE_DESKTOP_DEFAULT;
}

/** Whole CSS pixels per second inside the supported scrolling-speed range. */
export function parseDanmakuSpeed(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return DANMAKU_SPEED_DEFAULT;
  return Math.min(DANMAKU_SPEED_MAX, Math.max(DANMAKU_SPEED_MIN, Math.round(numeric)));
}

// `settings_set` writes one complete object. Serialize writes so rapid room
// controls (for example two slider commits) cannot resolve out of order and
// restore an earlier snapshot over the newest setting.
let settingsWriteQueue: Promise<void> = Promise.resolve();
let danmakuSendSettingEpoch = 0;
let asrSettingEpoch = 0;

type SettingsGetResponse = {
  settings: AppSettings;
  has_saved_settings: boolean;
};

function isSettingsGetResponse(
  value: AppSettings | SettingsGetResponse,
): value is SettingsGetResponse {
  return typeof value === "object" && value !== null && "settings" in value;
}

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

export const RECORDING_INCLUDE_DANMAKU_DEFAULT = false;
export const RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT = false;
export const FFMPEG_RW_TIMEOUT_SECONDS_MIN = 3;
export const FFMPEG_RW_TIMEOUT_SECONDS_MAX = 60;
export const FFMPEG_RW_TIMEOUT_SECONDS_DEFAULT = 10;
export const FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN = 1;
export const FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX = 60;
export const FFMPEG_RECONNECT_DELAY_MAX_SECONDS_DEFAULT = 8;
export const FFMPEG_HLS_SEGMENT_RETRY_COUNT_MIN = 0;
export const FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX = 20;
export const FFMPEG_HLS_SEGMENT_RETRY_COUNT_DEFAULT = 5;

function parseBoundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
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

export function recordingPreferencesFromAppSettings(
  settings: Pick<
    AppSettings,
    | "recording_include_danmaku"
    | "recording_continue_after_leave"
    | "ffmpeg_rw_timeout_seconds"
    | "ffmpeg_reconnect_delay_max_seconds"
    | "ffmpeg_hls_segment_retry_count"
  >,
) {
  return {
    recordingIncludeDanmaku:
      settings.recording_include_danmaku ?? RECORDING_INCLUDE_DANMAKU_DEFAULT,
    recordingContinueAfterLeave:
      settings.recording_continue_after_leave ?? RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT,
    ffmpegRwTimeoutSeconds: parseFfmpegRwTimeoutSeconds(settings.ffmpeg_rw_timeout_seconds),
    ffmpegReconnectDelayMaxSeconds: parseFfmpegReconnectDelayMaxSeconds(
      settings.ffmpeg_reconnect_delay_max_seconds,
    ),
    ffmpegHlsSegmentRetryCount: parseFfmpegHlsSegmentRetryCount(
      settings.ffmpeg_hls_segment_retry_count,
    ),
  };
}

function parseAsrFontSize(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return ASR_FONT_SIZE_DEFAULT;
  return Math.min(ASR_FONT_SIZE_MAX, Math.max(ASR_FONT_SIZE_MIN, Math.round(numeric)));
}

export const DANMAKU_MERGE_WINDOW_SECONDS_MIN = 0;
export const DANMAKU_MERGE_WINDOW_SECONDS_MAX = 30;
export const DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT = 10;

/** Whole seconds inside 0..=30, where 0 disables merging; invalid values fall back to 10s. */
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
  /** Platform opt-outs. An absent legacy setting means every platform is enabled. */
  disabledSiteIds: SiteId[];
  proxy: string | null;
  danmakuOpacity: number;
  danmakuFontSize: number;
  danmakuSpeed: number;
  danmakuArea: number;
  danmakuFontWeight: number;
  danmakuFilterGifts: boolean;
  danmakuMergeWindowSeconds: number;
  superChatEnabled: boolean;
  danmakuShieldWords: string[];
  qualityLevel: QualityLevel;
  playbackSmartLineSelection: boolean;
  playbackSoftSwitchEnabled: boolean;
  danmakuSendEnabled: boolean;
  /** True while the local multi-platform sending permission reaches the backend. */
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
  /** True while the device-local ASR choice reaches the Rust backend. */
  asrPending: boolean;
  /**
   * In-memory only revision for a send-capable account cookie. It deliberately
   * carries no credential data; consumers use it solely to invalidate cached
   * permission checks after a successful account update.
   */
  danmakuCookieRevision: number;
  /** Device-local custom IPTV M3U address; never included in profile packages. */
  iptvCustomM3uUrl: string | null;
  recordingIncludeDanmaku: boolean;
  recordingContinueAfterLeave: boolean;
  ffmpegRwTimeoutSeconds: number;
  ffmpegReconnectDelayMaxSeconds: number;
  ffmpegHlsSegmentRetryCount: number;
  /** True after first successful backend load. */
  hydratedFromBackend: boolean;
  setTheme: (theme: ThemeMode) => void;
  setSiteId: (siteId: string) => void;
  setSiteEnabled: (siteId: SiteId, enabled: boolean) => void;
  setProxy: (proxy: string | null) => void;
  setQualityLevel: (level: QualityLevel) => void;
  setPlaybackSmartLineSelection: (enabled: boolean) => void;
  setPlaybackSoftSwitchEnabled: (enabled: boolean) => void;
  setSuperChatEnabled: (enabled: boolean) => void;
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
  setRecordingContinueAfterLeave: (enabled: boolean) => void;
  setFfmpegRwTimeoutSeconds: (seconds: number) => void;
  setFfmpegReconnectDelayMaxSeconds: (seconds: number) => void;
  setFfmpegHlsSegmentRetryCount: (count: number) => void;
  applyFromBackend: (settings: AppSettings) => void;
  /** Load settings from Rust; backend becomes source of truth. */
  loadFromBackend: () => Promise<void>;
  /** Persist current settings (or partial merge) to Rust. */
  persistToBackend: (patch?: Partial<AppSettings>) => Promise<void>;
};

const defaultSettings: AppSettings = {
  theme: "system",
  motion_mode: "full",
  default_site: DEFAULT_SITE_ID,
  disabled_site_ids: [],
  proxy: null,
  danmaku_opacity: DANMAKU_OPACITY_DEFAULT,
  danmaku_font_size: defaultDanmakuFontSize(),
  danmaku_speed: DANMAKU_SPEED_DEFAULT,
  danmaku_area: DANMAKU_AREA_DEFAULT,
  danmaku_font_weight: 600,
  danmaku_filter_gifts: true,
  danmaku_merge_window_seconds: DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
  super_chat_enabled: true,
  danmaku_shield_words: [],
  quality_level: "high",
  playback_smart_line_selection: true,
  playback_soft_switch_enabled: true,
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
  recording_continue_after_leave: RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT,
  ffmpeg_rw_timeout_seconds: FFMPEG_RW_TIMEOUT_SECONDS_DEFAULT,
  ffmpeg_reconnect_delay_max_seconds: FFMPEG_RECONNECT_DELAY_MAX_SECONDS_DEFAULT,
  ffmpeg_hls_segment_retry_count: FFMPEG_HLS_SEGMENT_RETRY_COUNT_DEFAULT,
};

function toAppSettings(state: SettingsState): AppSettings {
  return {
    theme: state.theme,
    motion_mode: "full",
    default_site: state.siteId,
    disabled_site_ids: state.disabledSiteIds,
    proxy: state.proxy,
    danmaku_opacity: state.danmakuOpacity,
    danmaku_font_size: state.danmakuFontSize,
    danmaku_speed: state.danmakuSpeed,
    danmaku_area: state.danmakuArea,
    danmaku_font_weight: state.danmakuFontWeight,
    danmaku_filter_gifts: state.danmakuFilterGifts,
    danmaku_merge_window_seconds: state.danmakuMergeWindowSeconds,
    super_chat_enabled: state.superChatEnabled,
    danmaku_shield_words: state.danmakuShieldWords,
    quality_level: state.qualityLevel,
    playback_smart_line_selection: state.playbackSmartLineSelection,
    playback_soft_switch_enabled: state.playbackSoftSwitchEnabled,
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
    recording_continue_after_leave: state.recordingContinueAfterLeave,
    ffmpeg_rw_timeout_seconds: state.ffmpegRwTimeoutSeconds,
    ffmpeg_reconnect_delay_max_seconds: state.ffmpegReconnectDelayMaxSeconds,
    ffmpeg_hls_segment_retry_count: state.ffmpegHlsSegmentRetryCount,
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
      danmakuFontSize: defaultDanmakuFontSize(),
      danmakuSpeed: DANMAKU_SPEED_DEFAULT,
      danmakuArea: DANMAKU_AREA_DEFAULT,
      danmakuFontWeight: 600,
      danmakuFilterGifts: true,
      danmakuMergeWindowSeconds: DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
      superChatEnabled: true,
      danmakuShieldWords: [],
      qualityLevel: "high",
      playbackSmartLineSelection: true,
      playbackSoftSwitchEnabled: true,
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
      recordingContinueAfterLeave: RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT,
      ffmpegRwTimeoutSeconds: FFMPEG_RW_TIMEOUT_SECONDS_DEFAULT,
      ffmpegReconnectDelayMaxSeconds: FFMPEG_RECONNECT_DELAY_MAX_SECONDS_DEFAULT,
      ffmpegHlsSegmentRetryCount: FFMPEG_HLS_SEGMENT_RETRY_COUNT_DEFAULT,
      hydratedFromBackend: false,
      setTheme: (theme) => {
        set({ theme });
        void get().persistToBackend({ theme });
      },
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
      setProxy: (proxy) => {
        set({ proxy });
        void get().persistToBackend({ proxy });
      },
      setQualityLevel: (qualityLevel) => {
        set({ qualityLevel });
        void get().persistToBackend({ quality_level: qualityLevel });
      },
      setPlaybackSmartLineSelection: (playbackSmartLineSelection) => {
        set({ playbackSmartLineSelection });
        void get().persistToBackend({
          playback_smart_line_selection: playbackSmartLineSelection,
        });
      },
      setPlaybackSoftSwitchEnabled: (playbackSoftSwitchEnabled) => {
        set({ playbackSoftSwitchEnabled });
        void get().persistToBackend({
          playback_soft_switch_enabled: playbackSoftSwitchEnabled,
        });
      },
      setSuperChatEnabled: (superChatEnabled) => {
        set({ superChatEnabled });
        void get().persistToBackend({ super_chat_enabled: superChatEnabled });
      },
      setDanmakuSendEnabled: (danmakuSendEnabled) => {
        const epoch = ++danmakuSendSettingEpoch;
        set({ danmakuSendEnabled, danmakuSendPending: true });
        void get()
          .persistToBackend({ danmaku_send_enabled: danmakuSendEnabled })
          .finally(() => {
            // Rapidly toggling on/off queues two whole-settings writes. Only
            // the newest completion may clear the sync marker, otherwise the
            // composer could query the old backend value in between them.
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
      setAsrProvider: async (asrProvider) => {
        const previous = get().asrProvider;
        if (asrProvider === previous) return;
        const epoch = ++asrSettingEpoch;
        set({ asrProvider, asrPending: true });
        try {
          await get().persistToBackend({ asr_provider: asrProvider });
          if (get().asrEnabled) await invokeCmd("asr_enable");
        } catch (error) {
          if (epoch === asrSettingEpoch) {
            set({ asrProvider: previous });
            await get().persistToBackend({ asr_provider: previous });
          }
          throw error;
        } finally {
          if (epoch === asrSettingEpoch) set({ asrPending: false });
        }
      },
      setAsrVadEnabled: async (asrVadEnabled) => {
        const previous = get().asrVadEnabled;
        if (asrVadEnabled === previous) return;
        const epoch = ++asrSettingEpoch;
        set({ asrVadEnabled, asrPending: true });
        try {
          await get().persistToBackend({ asr_vad_enabled: asrVadEnabled });
          if (get().asrEnabled) await invokeCmd("asr_enable");
        } catch (error) {
          if (epoch === asrSettingEpoch) {
            set({ asrVadEnabled: previous });
            await get().persistToBackend({ asr_vad_enabled: previous });
          }
          throw error;
        } finally {
          if (epoch === asrSettingEpoch) set({ asrPending: false });
        }
      },
      setAsrPunctuationEnabled: async (asrPunctuationEnabled) => {
        const previous = get().asrPunctuationEnabled;
        if (asrPunctuationEnabled === previous) return;
        const epoch = ++asrSettingEpoch;
        set({ asrPunctuationEnabled, asrPending: true });
        try {
          await get().persistToBackend({ asr_punctuation_enabled: asrPunctuationEnabled });
          if (get().asrEnabled) await invokeCmd("asr_enable");
        } catch (error) {
          if (epoch === asrSettingEpoch) {
            set({ asrPunctuationEnabled: previous });
            await get().persistToBackend({ asr_punctuation_enabled: previous });
          }
          throw error;
        } finally {
          if (epoch === asrSettingEpoch) set({ asrPending: false });
        }
      },
      setAsrSpeakerDiarizationEnabled: async (asrSpeakerDiarizationEnabled) => {
        const previous = get().asrSpeakerDiarizationEnabled;
        if (asrSpeakerDiarizationEnabled === previous) return;
        const epoch = ++asrSettingEpoch;
        set({ asrSpeakerDiarizationEnabled, asrPending: true });
        try {
          await get().persistToBackend({
            asr_speaker_diarization_enabled: asrSpeakerDiarizationEnabled,
          });
          if (get().asrEnabled) await invokeCmd("asr_enable");
        } catch (error) {
          if (epoch === asrSettingEpoch) {
            set({ asrSpeakerDiarizationEnabled: previous });
            await get().persistToBackend({
              asr_speaker_diarization_enabled: previous,
            });
          }
          throw error;
        } finally {
          if (epoch === asrSettingEpoch) set({ asrPending: false });
        }
      },
      setAsrHotwords: async (asrHotwords) => {
        const normalized = Array.from(
          new Set(
            asrHotwords
              .map((word) => word.replace(/[\r\n\t]/g, " ").trim())
              .filter((word) => word.length > 0 && Array.from(word).length <= 80),
          ),
        ).slice(0, 100);
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
      setAsrTranslationEnabled: (asrTranslationEnabled) => {
        set({ asrTranslationEnabled });
        void get().persistToBackend({
          asr_translation_enabled: asrTranslationEnabled,
        });
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
        // This is intentionally not persisted. It has no meaning across an
        // app restart and must never contain the Cookie itself.
        set((state) => ({ danmakuCookieRevision: state.danmakuCookieRevision + 1 }));
      },
      setIptvCustomM3uUrl: (iptvCustomM3uUrl) => {
        const next = iptvCustomM3uUrl?.trim() || null;
        set({ iptvCustomM3uUrl: next });
        void get().persistToBackend({ iptv_custom_m3u_url: next });
      },
      setRecordingIncludeDanmaku: (recordingIncludeDanmaku) => {
        set({ recordingIncludeDanmaku });
        void get().persistToBackend({ recording_include_danmaku: recordingIncludeDanmaku });
      },
      setRecordingContinueAfterLeave: (recordingContinueAfterLeave) => {
        set({ recordingContinueAfterLeave });
        void get().persistToBackend({
          recording_continue_after_leave: recordingContinueAfterLeave,
        });
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
      applyFromBackend: (settings) => {
        const theme = isThemeMode(settings.theme) ? settings.theme : "system";
        const disabledSiteIds = normalizeDisabledSiteIds(settings.disabled_site_ids);
        set({
          theme,
          siteId: resolveEnabledSiteId(settings.default_site, disabledSiteIds),
          disabledSiteIds,
          proxy: settings.proxy,
          danmakuOpacity: settings.danmaku_opacity,
          danmakuFontSize: settings.danmaku_font_size,
          danmakuSpeed: parseDanmakuSpeed(settings.danmaku_speed),
          danmakuArea: settings.danmaku_area,
          danmakuFontWeight: settings.danmaku_font_weight,
          danmakuFilterGifts: settings.danmaku_filter_gifts ?? true,
          danmakuMergeWindowSeconds: parseDanmakuMergeWindowSeconds(
            settings.danmaku_merge_window_seconds,
          ),
          superChatEnabled: settings.super_chat_enabled ?? true,
          danmakuShieldWords: settings.danmaku_shield_words ?? [],
          qualityLevel: parseQualityLevel(settings.quality_level),
          playbackSmartLineSelection: settings.playback_smart_line_selection ?? true,
          playbackSoftSwitchEnabled: settings.playback_soft_switch_enabled ?? true,
          danmakuSendEnabled: settings.danmaku_send_enabled ?? false,
          danmakuSendPending: false,
          asrEnabled: settings.asr_enabled ?? false,
          asrProvider: parseAsrProvider(settings.asr_provider),
          asrVadEnabled: settings.asr_vad_enabled ?? true,
          asrPunctuationEnabled: settings.asr_punctuation_enabled ?? true,
          asrSpeakerDiarizationEnabled: settings.asr_speaker_diarization_enabled ?? false,
          asrHotwords: settings.asr_hotwords ?? [],
          asrWindowSeconds: parseAsrWindowSeconds(settings.asr_window_seconds),
          asrFontSize: parseAsrFontSize(settings.asr_font_size),
          asrTranslationEnabled: settings.asr_translation_enabled ?? false,
          asrTranslationFrom: normalizeCaptionTranslationFrom(settings.asr_translation_from),
          asrTranslationTo: normalizeCaptionTranslationTo(settings.asr_translation_to),
          asrPending: false,
          iptvCustomM3uUrl: settings.iptv_custom_m3u_url?.trim() || null,
          ...recordingPreferencesFromAppSettings(settings),
          hydratedFromBackend: true,
        });
      },
      loadFromBackend: async () => {
        try {
          const result = await invokeCmd<AppSettings | SettingsGetResponse>("settings_get");
          // A legacy backend returns AppSettings directly. Treat it as saved
          // rather than allowing a local cache to overwrite a real setting.
          const { settings, hasSavedSettings } = isSettingsGetResponse(result)
            ? {
                settings: result.settings,
                hasSavedSettings: result.has_saved_settings,
              }
            : { settings: result, hasSavedSettings: true };
          const localSiteId = get().siteId;
          const localDisabledSiteIds = get().disabledSiteIds;
          const disabledSiteIds = normalizeDisabledSiteIds(
            hasSavedSettings ? settings.disabled_site_ids : localDisabledSiteIds,
          );
          const siteId = resolveStartupSiteId(
            settings.default_site,
            hasSavedSettings,
            localSiteId,
            disabledSiteIds,
          );

          get().applyFromBackend({
            ...settings,
            ...(hasSavedSettings ? {} : { danmaku_font_size: defaultDanmakuFontSize() }),
            motion_mode: "full",
            default_site: siteId,
            disabled_site_ids: disabledSiteIds,
          });

          // Migrate a pre-backend local platform choice once. This makes the
          // choice durable without changing the first-run Bilibili default.
          if (!hasSavedSettings && (siteId !== DEFAULT_SITE_ID || disabledSiteIds.length > 0)) {
            await get().persistToBackend({
              default_site: siteId,
              disabled_site_ids: disabledSiteIds,
            });
          }
        } catch {
          // Outside Tauri (vite-only) or backend unavailable: keep local defaults.
          set({ hydratedFromBackend: true });
        }
      },
      persistToBackend: async (patch) => {
        // Avoid clobbering backend fields (proxy, danmaku_*) with
        // local defaults before loadFromBackend / applyFromBackend finishes.
        if (!get().hydratedFromBackend) {
          return;
        }
        const current = toAppSettings(get());
        const next: AppSettings = { ...defaultSettings, ...current, ...patch, motion_mode: "full" };
        settingsWriteQueue = settingsWriteQueue
          .catch(() => {})
          .then(async () => {
            try {
              await invokeCmd<void>("settings_set", { settings: next });
            } catch {
              // Ignore when not running under Tauri.
            }
          });
        await settingsWriteQueue;
      },
    }),
    {
      name: "rlive-settings",
      // Dual-write localStorage for theme flash; backend overwrites after load.
      partialize: (s) => ({
        theme: s.theme,
        siteId: s.siteId,
        disabledSiteIds: s.disabledSiteIds,
      }),
    },
  ),
);
