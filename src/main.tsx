import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { App } from "./app/App";
import { applyTheme, watchSystemThemeChanges } from "./app/theme";
import { getClientPlatform } from "./shared/clientPlatform";
import { watchKeyboardNavigation } from "./shared/keyboardNavigation";
import { useSettingsStore } from "./shared/stores/settingsStore";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toast";
import { preloadImageProxy } from "./shared/api/imageProxy";
import { applyFullMotion } from "./shared/motion/preference";
import { ASR_CAPTION_WINDOW_LABEL } from "./features/asr/asrCaptionWindowProtocol";
import "./styles.css";

// 独立字幕窗口与主窗口共用同一入口；按 label 分支，避免新窗口渲染路由、
// 预热图片代理或调用会被 `main_window_only` 拒绝的应用命令。
const AsrCaptionWindowApp = lazy(() => import("./features/asr/AsrCaptionWindowApp"));
const asrCaptionWindow = isTauri() && getCurrentWebviewWindow().label === ASR_CAPTION_WINDOW_LABEL;

if (getClientPlatform() === "android") {
  document.documentElement.dataset.platform = "android";
}

const initialSettings = useSettingsStore.getState();
// 焦点描边只在真实键盘导航时出现，所以要在首个可聚焦元素之前就开始记录输入来源。
watchKeyboardNavigation();
applyFullMotion();
applyTheme(initialSettings.theme);
useSettingsStore.subscribe((settings, previous) => {
  if (settings.theme !== previous.theme) applyTheme(settings.theme);
});
watchSystemThemeChanges(() => useSettingsStore.getState().theme);

const root = document.getElementById("root")!;

if (asrCaptionWindow) {
  // 主题与字号来自同源 localStorage；字幕窗口不读取后端设置。
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Suspense
        fallback={
          <div className="flex h-dvh items-center justify-center text-muted-foreground">
            正在载入字幕窗口…
          </div>
        }
      >
        <AsrCaptionWindowApp />
      </Suspense>
    </React.StrictMode>,
  );
} else {
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

  void useSettingsStore
    .getState()
    .loadFromBackend()
    .catch(() => {});
  // 尽早启动回环图片代理，使首屏绘制的封面与头像经由它路由，
  // 而不是被防盗链拒绝。
  void preloadImageProxy();

  ReactDOM.createRoot(root).render(
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
}
