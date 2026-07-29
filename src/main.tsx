import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { applyTheme } from "./app/theme";
import { getClientPlatform } from "./shared/clientPlatform";
import { useSettingsStore } from "./shared/stores/settingsStore";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toast";
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
applyTheme(useSettingsStore.getState().theme);
useSettingsStore.subscribe((s) => applyTheme(s.theme));
void useSettingsStore.getState().loadFromBackend();

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
