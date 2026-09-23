/**
 * 桌面原生窗口的全屏监听，带「卸载后迟到回收」。
 *
 * 为什么单独成模块：注册路径上有两处 `await`（初次 `sync`、`onResized`），
 * 而 React 的 cleanup 是同步的。cleanup 只能看到它执行那一刻已经赋值的
 * `unlisten`；如果卸载落在任一 await 中间，之后才拿到的订阅就没有任何人回收，
 * 旧实例的 resize 回调还会继续发窗口 IPC。把它抽出来是为了能直接用 deferred
 * Promise 卡住这两个位置做回归，而不是在 71KB 的 hook 里靠时序碰运气。
 *
 * 防护沿用弹幕 event bus 的做法：一个 `disposed` 标志，在每个 await 之后复查。
 */

/** 监听只需要窗口的这两个能力，测试因此不必构造完整的 Tauri Window。 */
export type DesktopFullscreenWindow = {
  isFullscreen: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
};

export type DesktopFullscreenWatcherOptions<W extends DesktopFullscreenWindow> = {
  /** 取原生窗口；没有原生窗口时允许抛错，调用方回退到 HTML 全屏路径。 */
  getWindow: () => W;
  /** 外部原生退出全屏后恢复最大化状态。 */
  restoreMaximized: (appWindow: W) => Promise<void>;
  setMode: (mode: "fullscreen" | "windowed") => void;
};

/**
 * 开始监听，返回同步的 dispose。
 *
 * dispose 之后的保证：
 *
 * - 不再调用 `setMode`；
 * - 不再发出新的窗口 IPC（迟到的 resize 回调在进入前就返回）；
 * - 监听恰好被回收一次，无论注册是在 dispose 之前还是之后返回。
 */
export function watchDesktopFullscreen<W extends DesktopFullscreenWindow>({
  getWindow,
  restoreMaximized,
  setMode,
}: DesktopFullscreenWatcherOptions<W>): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;

  void (async () => {
    try {
      const appWindow = getWindow();
      const sync = async () => {
        // 卸载后迟到的 resize 回调不得再发窗口 IPC。
        if (disposed) return;
        try {
          const fullscreen = await appWindow.isFullscreen();
          if (disposed) return;
          if (!fullscreen) {
            await restoreMaximized(appWindow);
            if (disposed) return;
          }
          setMode(fullscreen ? "fullscreen" : "windowed");
        } catch {
          /* 路由变更期间窗口可能正在拆除。 */
        }
      };
      await sync();
      // 初次 sync 期间已经卸载：不再注册新的监听。
      if (disposed) return;
      const registered = await appWindow.onResized(() => void sync());
      if (disposed) {
        // 注册在 cleanup 之后才返回，cleanup 看不到它，只能在这里立即回收。
        registered();
        return;
      }
      unlisten = registered;
    } catch {
      // 没有原生窗口的浏览器预览继续走 HTML 全屏路径。
    }
  })();

  return () => {
    disposed = true;
    // 先摘再调：dispose 被重复调用时不能回收两次。
    const pending = unlisten;
    unlisten = undefined;
    pending?.();
  };
}
