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
  danmakuShieldWords: string[];
  qualityLevel: QualityLevel;
  danmakuSendEnabled: boolean;
  /** True while the local multi-platform sending permission reaches the backend. */
  danmakuSendPending: boolean;
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
  setDanmakuSendEnabled: (enabled: boolean) => void;
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
  danmaku_opacity: 1,
  danmaku_font_size: 18,
  danmaku_speed: 8,
  danmaku_area: 0.9,
  danmaku_line_count: 0,
  danmaku_font_weight: 600,
  danmaku_filter_repeats: true,
  danmaku_filter_gifts: true,
  super_chat_enabled: true,
  danmaku_shield_words: [],
  quality_level: "high",
  danmaku_send_enabled: false,
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
    danmaku_shield_words: state.danmakuShieldWords,
    quality_level: state.qualityLevel,
    danmaku_send_enabled: state.danmakuSendEnabled,
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
      danmakuShieldWords: [],
      qualityLevel: "high",
      danmakuSendEnabled: false,
      danmakuSendPending: false,
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
          danmakuShieldWords: settings.danmaku_shield_words ?? [],
          qualityLevel: parseQualityLevel(settings.quality_level),
          danmakuSendEnabled: settings.danmaku_send_enabled ?? false,
          danmakuSendPending: false,
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
