import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { applyTheme } from "./app/theme";
import { useSettingsStore } from "./shared/stores/settingsStore";
import "./styles.css";

const queryClient = new QueryClient();
applyTheme(useSettingsStore.getState().theme);
useSettingsStore.subscribe((s) => applyTheme(s.theme));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
