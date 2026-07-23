import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { FullscreenOverlayRoot } from "./features/room/FullscreenOverlayRoot";
import { applyTheme } from "./app/theme";
import { useSettingsStore } from "./shared/stores/settingsStore";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";

const isOverlay =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("overlay") === "1";

const queryClient = new QueryClient();
applyTheme(useSettingsStore.getState().theme);
useSettingsStore.subscribe((s) => applyTheme(s.theme));
// Backend is source of truth after load (overrides localStorage dual-write).
if (!isOverlay) {
  void useSettingsStore.getState().loadFromBackend();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {isOverlay ? <FullscreenOverlayRoot /> : <App />}
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
