import { useCallback, useEffect, useState } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type WindowAction = "close" | "minimize" | "toggleMaximize";

function hasTauriWindow(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * A deliberately quiet desktop title bar. It gives the player a real window
 * frame without spending vertical space on a second application header.
 */
export function AppTitleBar() {
  const [maximized, setMaximized] = useState(false);

  const refreshMaximizedState = useCallback(async () => {
    if (!hasTauriWindow()) return;
    try {
      setMaximized(await getCurrentWindow().isMaximized());
    } catch {
      // Keep browser/Vite preview usable too. Native window controls are a
      // progressive enhancement rather than a requirement to render Shell.
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
        // The same component is used by browser-based previews and tests.
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
        // Do not surface an application error for a platform that does not
        // expose a native frame action (for example a browser preview).
      }
    },
    [refreshMaximizedState],
  );

  const toggleMaximize = useCallback(() => {
    void performWindowAction("toggleMaximize");
  }, [performWindowAction]);

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-9 shrink-0 items-stretch border-b border-border-subtle bg-sidebar/95 text-xs select-none"
      aria-label="应用标题栏"
      onDoubleClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button")) return;
        toggleMaximize();
      }}
    >
      <div data-tauri-drag-region className="flex w-[68px] shrink-0 items-center justify-center">
        <img src="/rlive.svg" alt="rLive" draggable={false} className="size-4.5 rounded-[5px]" />
      </div>

      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
        <span className="font-medium tracking-[0.01em] text-foreground/85">rLive</span>
        <span aria-hidden="true" className="text-border-subtle">
          /
        </span>
        <span className="truncate text-muted-foreground">直播桌面客户端</span>
      </div>

      <div className="relative z-10 flex h-full items-stretch">
        <button
          type="button"
          className="flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label="最小化"
          title="最小化"
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={() => void performWindowAction("minimize")}
        >
          <Minus className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={maximized ? "还原窗口" : "最大化"}
          title={maximized ? "还原窗口" : "最大化"}
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
        <button
          type="button"
          className="flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-destructive hover:text-destructive-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label="关闭"
          title="关闭"
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={() => void performWindowAction("close")}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
