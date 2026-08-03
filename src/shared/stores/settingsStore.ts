import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invokeCmd } from "../api/tauri";
import {
  DEFAULT_SITE_ID,
  normalizeDisabledSiteIds,
  resolveEnabledSiteId,
  resolveStartupSiteId,
  updateDisabledSiteIds,
} from "../siteId";
import type { AppSettings, SiteId } from "../types/live";
import type { QualityLevel } from "../types/player";

export type ThemeMode = "system" | "light" | "dark";

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

const ASR_FONT_SIZE_MIN = 12;
const ASR_FONT_SIZE_MAX = 48;
const ASR_FONT_SIZE_DEFAULT = 20;
const ASR_WINDOW_SECONDS_MIN = 1;
const ASR_WINDOW_SECONDS_MAX = 6;
const ASR_WINDOW_SECONDS_DEFAULT = 1;

function parseAsrFontSize(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return ASR_FONT_SIZE_DEFAULT;
  return Math.min(ASR_FONT_SIZE_MAX, Math.max(ASR_FONT_SIZE_MIN, Math.round(numeric)));
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
  danmakuLineCount: number;
  danmakuFontWeight: number;
  danmakuFilterRepeats: boolean;
  danmakuFilterGifts: boolean;
  superChatEnabled: boolean;
  superChatOpacity: number;
  danmakuShieldWords: string[];
  qualityLevel: QualityLevel;
  danmakuSendEnabled: boolean;
  /** True while the local multi-platform sending permission reaches the backend. */
  danmakuSendPending: boolean;
  asrEnabled: boolean;
  asrVadEnabled: boolean;
  asrWindowSeconds: number;
  asrFontSize: number;
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
  /** True after first successful backend load. */
  hydratedFromBackend: boolean;
  setTheme: (theme: ThemeMode) => void;
  setSiteId: (siteId: string) => void;
  setSiteEnabled: (siteId: SiteId, enabled: boolean) => void;
  setProxy: (proxy: string | null) => void;
  setQualityLevel: (level: QualityLevel) => void;
  setSuperChatEnabled: (enabled: boolean) => void;
  setSuperChatOpacity: (opacity: number) => void;
  setDanmakuSendEnabled: (enabled: boolean) => void;
  setAsrEnabled: (enabled: boolean) => Promise<void>;
  setAsrVadEnabled: (enabled: boolean) => Promise<void>;
  setAsrWindowSeconds: (seconds: number) => Promise<void>;
  markDanmakuCookieChanged: () => void;
  setIptvCustomM3uUrl: (url: string | null) => void;
  applyFromBackend: (settings: AppSettings) => void;
  /** Load settings from Rust; backend becomes source of truth. */
  loadFromBackend: () => Promise<void>;
  /** Persist current settings (or partial merge) to Rust. */
  persistToBackend: (patch?: Partial<AppSettings>) => Promise<void>;
};

const defaultSettings: AppSettings = {
  theme: "system",
  default_site: DEFAULT_SITE_ID,
  disabled_site_ids: [],
  proxy: null,
  danmaku_opacity: 0.8,
  danmaku_font_size: 18,
  danmaku_speed: 8,
  danmaku_area: 0.9,
  danmaku_line_count: 0,
  danmaku_font_weight: 600,
  danmaku_filter_repeats: true,
  danmaku_filter_gifts: true,
  super_chat_enabled: true,
  super_chat_opacity: 1,
  danmaku_shield_words: [],
  quality_level: "high",
  danmaku_send_enabled: false,
  asr_enabled: false,
  asr_vad_enabled: false,
  asr_window_seconds: ASR_WINDOW_SECONDS_DEFAULT,
  asr_font_size: ASR_FONT_SIZE_DEFAULT,
  iptv_custom_m3u_url: null,
};

function toAppSettings(state: SettingsState): AppSettings {
  return {
    theme: state.theme,
    default_site: state.siteId,
    disabled_site_ids: state.disabledSiteIds,
    proxy: state.proxy,
    danmaku_opacity: state.danmakuOpacity,
    danmaku_font_size: state.danmakuFontSize,
    danmaku_speed: state.danmakuSpeed,
    danmaku_area: state.danmakuArea,
    danmaku_line_count: state.danmakuLineCount,
    danmaku_font_weight: state.danmakuFontWeight,
    danmaku_filter_repeats: state.danmakuFilterRepeats,
    danmaku_filter_gifts: state.danmakuFilterGifts,
    super_chat_enabled: state.superChatEnabled,
    super_chat_opacity: state.superChatOpacity,
    danmaku_shield_words: state.danmakuShieldWords,
    quality_level: state.qualityLevel,
    danmaku_send_enabled: state.danmakuSendEnabled,
    asr_enabled: state.asrEnabled,
    asr_vad_enabled: state.asrVadEnabled,
    asr_window_seconds: state.asrWindowSeconds,
    asr_font_size: state.asrFontSize,
    iptv_custom_m3u_url: state.iptvCustomM3uUrl,
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: "system",
      siteId: DEFAULT_SITE_ID,
      disabledSiteIds: [],
      proxy: null,
      danmakuOpacity: 1,
      danmakuFontSize: 18,
      danmakuSpeed: 8,
      danmakuArea: 0.9,
      danmakuLineCount: 0,
      danmakuFontWeight: 600,
      danmakuFilterRepeats: true,
      danmakuFilterGifts: true,
      superChatEnabled: true,
      superChatOpacity: 1,
      danmakuShieldWords: [],
      qualityLevel: "high",
      danmakuSendEnabled: false,
      danmakuSendPending: false,
      asrEnabled: false,
      asrVadEnabled: false,
      asrWindowSeconds: ASR_WINDOW_SECONDS_DEFAULT,
      asrFontSize: ASR_FONT_SIZE_DEFAULT,
      asrPending: false,
      danmakuCookieRevision: 0,
      iptvCustomM3uUrl: null,
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
      setSuperChatEnabled: (superChatEnabled) => {
        set({ superChatEnabled });
        void get().persistToBackend({ super_chat_enabled: superChatEnabled });
      },
      setSuperChatOpacity: (superChatOpacity) => {
        set({ superChatOpacity });
        void get().persistToBackend({ super_chat_opacity: superChatOpacity });
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
      setAsrVadEnabled: async (asrVadEnabled) => {
        const epoch = ++asrSettingEpoch;
        const previous = get().asrVadEnabled;
        if (asrVadEnabled === previous) return;
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
          danmakuSpeed: settings.danmaku_speed,
          danmakuArea: settings.danmaku_area,
          danmakuLineCount: settings.danmaku_line_count,
          danmakuFontWeight: settings.danmaku_font_weight,
          danmakuFilterRepeats: settings.danmaku_filter_repeats,
          danmakuFilterGifts: settings.danmaku_filter_gifts ?? true,
          superChatEnabled: settings.super_chat_enabled ?? true,
          superChatOpacity: settings.super_chat_opacity ?? 1,
          danmakuShieldWords: settings.danmaku_shield_words ?? [],
          qualityLevel: parseQualityLevel(settings.quality_level),
          danmakuSendEnabled: settings.danmaku_send_enabled ?? false,
          danmakuSendPending: false,
          asrEnabled: settings.asr_enabled ?? false,
          asrVadEnabled: settings.asr_vad_enabled ?? false,
          asrWindowSeconds: parseAsrWindowSeconds(settings.asr_window_seconds),
          asrFontSize: parseAsrFontSize(settings.asr_font_size),
          asrPending: false,
          iptvCustomM3uUrl: settings.iptv_custom_m3u_url?.trim() || null,
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
        const next: AppSettings = { ...defaultSettings, ...current, ...patch };
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
