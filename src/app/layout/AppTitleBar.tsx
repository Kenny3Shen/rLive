import { useCallback, useEffect, useState } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMobileClient } from "@/shared/clientPlatform";

type WindowAction = "close" | "minimize" | "toggleMaximize";

function hasTauriWindow(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 刻意保持低调的桌面标题栏。它为播放器提供真实的窗口边框，
 * 却不为第二个应用头部消耗纵向空间。
 */
export function AppTitleBar() {
  return isMobileClient() ? null : <DesktopAppTitleBar />;
}

function DesktopAppTitleBar() {
  const [maximized, setMaximized] = useState(false);

  const refreshMaximizedState = useCallback(async () => {
    if (!hasTauriWindow()) return;
    try {
      setMaximized(await getCurrentWindow().isMaximized());
    } catch {
      // 保持浏览器/Vite 预览同样可用。原生窗口控制是渐进增强，
      // 而不是渲染 Shell 的前提。
    }
  }, []);

  useEffect(() => {
    if (!hasTauriWindow()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        const nextMaximized = await appWindow.isMaximized();
        if (!disposed) setMaximized(nextMaximized);
        unlisten = await appWindow.onResized(() => {
          void refreshMaximizedState();
        });
      } catch {
        // 基于浏览器的预览与测试复用同一个组件。
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshMaximizedState]);

  const performWindowAction = useCallback(
    async (action: WindowAction) => {
      if (!hasTauriWindow()) return;
      try {
        await getCurrentWindow()[action]();
        if (action === "toggleMaximize") await refreshMaximizedState();
      } catch {
        // 对不提供原生窗口操作的平台（例如浏览器预览），
        // 不要抛出应用层错误。
      }
    },
    [refreshMaximizedState],
  );

  const toggleMaximize = useCallback(() => {
    void performWindowAction("toggleMaximize");
  }, [performWindowAction]);

  // Tauri 2 只在点击的正是带拖拽区域属性的那个元素时才把它当作可拖拽。
  // 标题栏大部分由后代元素构成，因此使用 `deep`，
  // 并在下方显式让窗口按钮退出拖拽。
  return (
    <header
      data-tauri-drag-region="deep"
      className="relative isolate flex h-9 shrink-0 items-stretch border-b border-border-subtle bg-sidebar/95 text-xs select-none max-md:hidden"
      aria-label="应用标题栏"
    >
      <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2 px-3">
        <img src="/rlive.svg" alt="rLive" draggable={false} className="size-4.5 rounded-[5px]" />
        <span className="truncate font-medium tracking-[0.01em] text-foreground/85">rLive</span>
      </div>

      <div className="relative z-10 flex h-full items-stretch">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-tauri-drag-region="false"
                className="flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:z-10"
                aria-label="最小化"
                onMouseDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={() => void performWindowAction("minimize")}
              >
                <Minus className="size-3.5" aria-hidden="true" />
              </button>
            }
          />
          <TooltipContent side="bottom">最小化</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-tauri-drag-region="false"
                className="flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:z-10"
                aria-label={maximized ? "还原窗口" : "最大化"}
                onMouseDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={toggleMaximize}
              >
                {maximized ? (
                  <Minimize2 className="size-3.5" aria-hidden="true" />
                ) : (
                  <Maximize2 className="size-3.5" aria-hidden="true" />
                )}
              </button>
            }
          />
          <TooltipContent side="bottom">{maximized ? "还原窗口" : "最大化"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-tauri-drag-region="false"
                className="flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-destructive hover:text-destructive-foreground focus-visible:z-10"
                aria-label="关闭"
                onMouseDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={() => void performWindowAction("close")}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            }
          />
          <TooltipContent side="bottom">关闭</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
