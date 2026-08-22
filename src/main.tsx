import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { applyTheme } from "./app/theme";
import { getClientPlatform } from "./shared/clientPlatform";
import { useSettingsStore } from "./shared/stores/settingsStore";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toast";
import { preloadImageProxy } from "./shared/api/imageProxy";
import { applyFullMotion } from "./shared/motion/preference";
import "./styles.css";

if (getClientPlatform() === "android") {
  document.documentElement.dataset.platform = "android";
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Browsing data changes far less frequently than video state. Keep it
      // warm across route switches and do not fan out background IPC/network
      // requests merely because the desktop window regained focus. Playback
      // metadata overrides this with its own short-lived policy.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});
const initialSettings = useSettingsStore.getState();
applyFullMotion();
applyTheme(initialSettings.theme);
useSettingsStore.subscribe((settings, previous) => {
  if (settings.theme !== previous.theme) applyTheme(settings.theme);
});
void useSettingsStore
  .getState()
  .loadFromBackend()
  .catch(() => {});
// Start the loopback image proxy as early as possible so first-paint covers
// and avatars route through it instead of being hotlink-rejected.
void preloadImageProxy();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster>
          <App />
        </Toaster>
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
