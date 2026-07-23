import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "system" | "light" | "dark";

type SettingsState = {
  theme: ThemeMode;
  siteId: string;
  setTheme: (theme: ThemeMode) => void;
  setSiteId: (siteId: string) => void;
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      siteId: "bilibili",
      setTheme: (theme) => set({ theme }),
      setSiteId: (siteId) => set({ siteId }),
    }),
    { name: "rlive-settings" },
  ),
);
