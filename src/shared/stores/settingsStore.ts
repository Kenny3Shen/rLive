import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invokeCmd } from "../api/tauri";
import { DEFAULT_SITE_ID, isSiteId, normalizeSiteId, resolveStartupSiteId } from "../siteId";
import type { AppSettings } from "../types/live";
import type { QualityLevel } from "../types/player";

export type ThemeMode = "system" | "light" | "dark";

// `settings_set` writes one complete object. Serialize writes so rapid room
// controls (for example two slider commits) cannot resolve out of order and
// restore an earlier snapshot over the newest setting.
let settingsWriteQueue: Promise<void> = Promise.resolve();
let bilibiliSendSettingEpoch = 0;

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
  proxy: string | null;
  danmakuOpacity: number;
  danmakuFontSize: number;
  danmakuSpeed: number;
  danmakuArea: number;
  danmakuLineCount: number;
  danmakuFontWeight: number;
  danmakuFilterRepeats: boolean;
  danmakuFilterGifts: boolean;
  danmakuShieldWords: string[];
  mpvPath: string | null;
  qualityLevel: QualityLevel;
  bilibiliDanmakuSendEnabled: boolean;
  /** True while the explicit Bilibili write opt-in is reaching the backend. */
  bilibiliDanmakuSendPending: boolean;
  douyinDanmakuSignService: string | null;
  /** True after first successful backend load. */
  hydratedFromBackend: boolean;
  setTheme: (theme: ThemeMode) => void;
  setSiteId: (siteId: string) => void;
  setProxy: (proxy: string | null) => void;
  setMpvPath: (mpvPath: string | null) => void;
  setQualityLevel: (level: QualityLevel) => void;
  setBilibiliDanmakuSendEnabled: (enabled: boolean) => void;
  setDouyinDanmakuSignService: (url: string | null) => void;
  applyFromBackend: (settings: AppSettings) => void;
  /** Load settings from Rust; backend becomes source of truth. */
  loadFromBackend: () => Promise<void>;
  /** Persist current settings (or partial merge) to Rust. */
  persistToBackend: (patch?: Partial<AppSettings>) => Promise<void>;
};

const defaultSettings: AppSettings = {
  theme: "system",
  default_site: DEFAULT_SITE_ID,
  proxy: null,
  danmaku_opacity: 1,
  danmaku_font_size: 18,
  danmaku_speed: 8,
  danmaku_area: 0.9,
  danmaku_line_count: 0,
  danmaku_font_weight: 600,
  danmaku_filter_repeats: true,
  danmaku_filter_gifts: false,
  danmaku_shield_words: [],
  mpv_path: null,
  quality_level: "high",
  bilibili_danmaku_send_enabled: false,
  douyin_danmaku_sign_service: null,
};

function toAppSettings(state: SettingsState): AppSettings {
  return {
    theme: state.theme,
    default_site: state.siteId,
    proxy: state.proxy,
    danmaku_opacity: state.danmakuOpacity,
    danmaku_font_size: state.danmakuFontSize,
    danmaku_speed: state.danmakuSpeed,
    danmaku_area: state.danmakuArea,
    danmaku_line_count: state.danmakuLineCount,
    danmaku_font_weight: state.danmakuFontWeight,
    danmaku_filter_repeats: state.danmakuFilterRepeats,
    danmaku_filter_gifts: state.danmakuFilterGifts,
    danmaku_shield_words: state.danmakuShieldWords,
    mpv_path: state.mpvPath,
    quality_level: state.qualityLevel,
    bilibili_danmaku_send_enabled: state.bilibiliDanmakuSendEnabled,
    douyin_danmaku_sign_service: state.douyinDanmakuSignService,
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: "system",
      siteId: DEFAULT_SITE_ID,
      proxy: null,
      danmakuOpacity: 1,
      danmakuFontSize: 18,
      danmakuSpeed: 8,
      danmakuArea: 0.9,
      danmakuLineCount: 0,
      danmakuFontWeight: 600,
      danmakuFilterRepeats: true,
      danmakuFilterGifts: false,
      danmakuShieldWords: [],
      mpvPath: null,
      qualityLevel: "high",
      bilibiliDanmakuSendEnabled: false,
      bilibiliDanmakuSendPending: false,
      douyinDanmakuSignService: null,
      hydratedFromBackend: false,
      setTheme: (theme) => {
        set({ theme });
        void get().persistToBackend({ theme });
      },
      setSiteId: (siteId) => {
        set({ siteId });
        void get().persistToBackend({ default_site: siteId });
      },
      setProxy: (proxy) => {
        set({ proxy });
        void get().persistToBackend({ proxy });
      },
      setMpvPath: (mpvPath) => {
        set({ mpvPath });
        void get().persistToBackend({ mpv_path: mpvPath });
      },
      setQualityLevel: (qualityLevel) => {
        set({ qualityLevel });
        void get().persistToBackend({ quality_level: qualityLevel });
      },
      setBilibiliDanmakuSendEnabled: (bilibiliDanmakuSendEnabled) => {
        const epoch = ++bilibiliSendSettingEpoch;
        set({ bilibiliDanmakuSendEnabled, bilibiliDanmakuSendPending: true });
        void get()
          .persistToBackend({ bilibili_danmaku_send_enabled: bilibiliDanmakuSendEnabled })
          .finally(() => {
            // Rapidly toggling on/off queues two whole-settings writes. Only
            // the newest completion may clear the sync marker, otherwise the
            // composer could query the old backend value in between them.
            if (epoch === bilibiliSendSettingEpoch) {
              set({ bilibiliDanmakuSendPending: false });
            }
          });
      },
      setDouyinDanmakuSignService: (douyinDanmakuSignService) => {
        set({ douyinDanmakuSignService });
        void get().persistToBackend({ douyin_danmaku_sign_service: douyinDanmakuSignService });
      },
      applyFromBackend: (settings) => {
        const theme = isThemeMode(settings.theme) ? settings.theme : "system";
        set({
          theme,
          siteId: normalizeSiteId(settings.default_site),
          proxy: settings.proxy,
          danmakuOpacity: settings.danmaku_opacity,
          danmakuFontSize: settings.danmaku_font_size,
          danmakuSpeed: settings.danmaku_speed,
          danmakuArea: settings.danmaku_area,
          danmakuLineCount: settings.danmaku_line_count,
          danmakuFontWeight: settings.danmaku_font_weight,
          danmakuFilterRepeats: settings.danmaku_filter_repeats,
          danmakuFilterGifts: settings.danmaku_filter_gifts ?? false,
          danmakuShieldWords: settings.danmaku_shield_words ?? [],
          mpvPath: settings.mpv_path,
          qualityLevel: parseQualityLevel(settings.quality_level),
          bilibiliDanmakuSendEnabled: settings.bilibili_danmaku_send_enabled ?? false,
          bilibiliDanmakuSendPending: false,
          douyinDanmakuSignService: settings.douyin_danmaku_sign_service?.trim() || null,
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
          const siteId = resolveStartupSiteId(settings.default_site, hasSavedSettings, localSiteId);

          get().applyFromBackend({ ...settings, default_site: siteId });

          // Migrate a pre-backend local platform choice once. This makes the
          // choice durable without changing the first-run Bilibili default.
          if (!hasSavedSettings && isSiteId(localSiteId) && siteId !== DEFAULT_SITE_ID) {
            await get().persistToBackend({ default_site: siteId });
          }
        } catch {
          // Outside Tauri (vite-only) or backend unavailable: keep local defaults.
          set({ hydratedFromBackend: true });
        }
      },
      persistToBackend: async (patch) => {
        // Avoid clobbering backend fields (proxy, danmaku_*, mpv_path) with
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
      }),
    },
  ),
);
