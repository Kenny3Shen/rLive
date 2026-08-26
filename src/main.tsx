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
      // 浏览数据的变化频率远低于视频状态。让它跨路由切换保持热缓存，
      // 也不要仅因为桌面窗口重新获得焦点就扇出后台 IPC/网络请求。
      // 播放元数据以自己的短时效策略覆盖这一默认值。
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
// 尽早启动回环图片代理，使首屏绘制的封面与头像经由它路由，
// 而不是被防盗链拒绝。
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
