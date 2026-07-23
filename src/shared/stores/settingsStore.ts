import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invokeCmd } from "../api/tauri";
import type { AppSettings } from "../types/live";

export type ThemeMode = "system" | "light" | "dark";

function isThemeMode(v: string): v is ThemeMode {
  return v === "system" || v === "light" || v === "dark";
}

type SettingsState = {
  theme: ThemeMode;
  siteId: string;
  proxy: string | null;
  danmakuOpacity: number;
  danmakuFontSize: number;
  danmakuSpeed: number;
  danmakuShieldWords: string[];
  mpvPath: string | null;
  /** True after first successful backend load. */
  hydratedFromBackend: boolean;
  setTheme: (theme: ThemeMode) => void;
  setSiteId: (siteId: string) => void;
  setProxy: (proxy: string | null) => void;
  applyFromBackend: (settings: AppSettings) => void;
  /** Load settings from Rust; backend becomes source of truth. */
  loadFromBackend: () => Promise<void>;
  /** Persist current settings (or partial merge) to Rust. */
  persistToBackend: (patch?: Partial<AppSettings>) => Promise<void>;
};

const defaultSettings: AppSettings = {
  theme: "system",
  default_site: "bilibili",
  proxy: null,
  danmaku_opacity: 1,
  danmaku_font_size: 18,
  danmaku_speed: 8,
  danmaku_shield_words: [],
  mpv_path: null,
};

function toAppSettings(state: SettingsState): AppSettings {
  return {
    theme: state.theme,
    default_site: state.siteId,
    proxy: state.proxy,
    danmaku_opacity: state.danmakuOpacity,
    danmaku_font_size: state.danmakuFontSize,
    danmaku_speed: state.danmakuSpeed,
    danmaku_shield_words: state.danmakuShieldWords,
    mpv_path: state.mpvPath,
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: "system",
      siteId: "bilibili",
      proxy: null,
      danmakuOpacity: 1,
      danmakuFontSize: 18,
      danmakuSpeed: 8,
      danmakuShieldWords: [],
      mpvPath: null,
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
      applyFromBackend: (settings) => {
        const theme = isThemeMode(settings.theme) ? settings.theme : "system";
        set({
          theme,
          siteId: settings.default_site || "bilibili",
          proxy: settings.proxy,
          danmakuOpacity: settings.danmaku_opacity,
          danmakuFontSize: settings.danmaku_font_size,
          danmakuSpeed: settings.danmaku_speed,
          danmakuShieldWords: settings.danmaku_shield_words ?? [],
          mpvPath: settings.mpv_path,
          hydratedFromBackend: true,
        });
      },
      loadFromBackend: async () => {
        try {
          const settings = await invokeCmd<AppSettings>("settings_get");
          get().applyFromBackend(settings);
        } catch {
          // Outside Tauri (vite-only) or backend unavailable: keep local defaults.
          set({ hydratedFromBackend: true });
        }
      },
      persistToBackend: async (patch) => {
        const current = toAppSettings(get());
        const next: AppSettings = { ...defaultSettings, ...current, ...patch };
        try {
          await invokeCmd<void>("settings_set", { settings: next });
        } catch {
          // Ignore when not running under Tauri.
        }
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
