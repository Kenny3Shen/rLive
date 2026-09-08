import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
import {
  runningOnAndroidTauri,
  setAndroidImmersive,
} from "@/features/room/player/androidImmersive";
import {
  fullscreenElementFor,
  getFullscreenDocument,
  isTauriDesktop,
  toggleElementFullscreen,
} from "@/features/room/player/useWebPlayer";
import { useFullscreenInsetFreeze } from "@/shared/hooks/useFullscreenInsetFreeze";
import {
  createNativeFullscreenSession,
  restoreNativePlayerMaximizedState,
  setNativePlayerFullscreen,
  toggleNativePlayerFullscreen,
} from "@/shared/nativePlayerFullscreen";

function fullscreenErrorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    const message = String((error as { message: unknown }).message).trim();
    if (message) return message;
  }
  const message = String(error ?? "").trim();
  return message || "全屏切换失败";
}

/**
 * 与直播播放器 UI 契约共享的全屏适配器，三条实现路径：
 *
 * - 桌面 Tauri：原生窗口全屏（无 HTML 全屏元素）。
 * - Android Tauri：页面内固定层 + 原生沉浸式系统栏。刻意不用 Fullscreen API ——
 *   Chromium 为全屏元素重新挂载渲染表面，那次交接就是黑屏闪烁（见 `androidImmersive`）。
 * - 其余（移动 Web / 桌面浏览器）：元素级 Fullscreen API。
 *
 * `nativeLayer` 为 true 表示「全屏是 CSS 固定层」，调用方据此给舞台加
 * `data-fullscreen`；HTML 全屏由 `:fullscreen` 自己接管，不需要该属性。
 */
export function useRecordingPlayerFullscreen(
  stageRef: RefObject<HTMLElement | null>,
  /** Back/Escape 请求退出时返回 false 可消费请求而保留全屏。 */
  onExitRequest?: () => boolean,
) {
  const nativeSessionRef = useRef(createNativeFullscreenSession());
  const fullscreenRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  fullscreenRef.current = fullscreen;
  const exitRequestRef = useRef(onExitRequest);
  exitRequestRef.current = onExitRequest;
  const androidInPage = runningOnAndroidTauri();
  const { freeze: freezeInsets, release: releaseInsets } = useFullscreenInsetFreeze();

  /**
   * 进入或离开 Android 的页面内全屏固定层。
   *
   * 原生沉浸式命令失败或缺失时仍然得到可用的全屏（只是系统栏可见），因此
   * invoke 绝不阻塞状态变更。系统栏动画会让 `env(safe-area-inset-top)` 经过数帧
   * 变化，而 `.app-shell` 把它消费为 `padding-top`：舞台此时已是 `position: fixed`
   * 不会动，但其后的页面 chrome 仍会回流并在固定层边缘显露 —— 跨过渡冻结外壳
   * 内边距。这条路径没有 `fullscreenchange`，由冻结自带的超时负责释放。
   */
  const setInPageFullscreen = useCallback(
    (next: boolean) => {
      if (next) freezeInsets();
      else releaseInsets();
      fullscreenRef.current = next;
      setFullscreen(next);
      setError(null);
      void setAndroidImmersive(next).catch(() => {
        // 缺少该命令的旧 APK 不得破坏全屏。
      });
    },
    [freezeInsets, releaseInsets],
  );

  useEffect(() => {
    if (isTauriDesktop() || androidInPage) return;
    const sync = () => {
      const stage = stageRef.current;
      const element = fullscreenElementFor(getFullscreenDocument());
      setFullscreen(Boolean(stage && element && (element === stage || stage.contains(element))));
      releaseInsets();
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [androidInPage, releaseInsets, stageRef]);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        const sync = async () => {
          try {
            const active = await appWindow.isFullscreen();
            if (!active) {
              await restoreNativePlayerMaximizedState(appWindow, nativeSessionRef.current);
            }
            if (!disposed) setFullscreen(active);
          } catch {
            // 路由拆除期间原生窗口可能已经在关闭。
          }
        };
        await sync();
        unlisten = await appWindow.onResized(() => void sync());
      } catch {
        // 浏览器预览使用上方的 HTML 全屏方案。
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const exit = useCallback(async () => {
    if (isTauriDesktop()) {
      try {
        const appWindow = getCurrentWindow();
        if (await appWindow.isFullscreen()) {
          await setNativePlayerFullscreen(appWindow, false, nativeSessionRef.current);
        }
        setFullscreen(false);
        setError(null);
      } catch (cause) {
        setError(fullscreenErrorMessage(cause));
      }
      return;
    }

    if (androidInPage) {
      if (fullscreenRef.current) setInPageFullscreen(false);
      return;
    }

    const documentRef = getFullscreenDocument();
    const element = fullscreenElementFor(documentRef);
    const stage = stageRef.current;
    if (!documentRef || !element || !stage || (element !== stage && !stage.contains(element))) {
      return;
    }
    const exitFullscreen =
      documentRef.exitFullscreen ??
      documentRef.webkitExitFullscreen ??
      documentRef.webkitCancelFullScreen;
    if (!exitFullscreen) return;
    try {
      await Promise.resolve(exitFullscreen.call(documentRef));
      setError(null);
    } catch (cause) {
      releaseInsets();
      setError(fullscreenErrorMessage(cause));
    }
  }, [androidInPage, releaseInsets, setInPageFullscreen, stageRef]);

  const toggle = useCallback(async () => {
    if (isTauriDesktop()) {
      try {
        const active = await toggleNativePlayerFullscreen(
          getCurrentWindow(),
          nativeSessionRef.current,
        );
        setFullscreen(active);
        setError(null);
      } catch (cause) {
        setError(fullscreenErrorMessage(cause));
      }
      return;
    }

    if (androidInPage) {
      setInPageFullscreen(!fullscreenRef.current);
      return;
    }

    try {
      if (!fullscreenElementFor(getFullscreenDocument())) freezeInsets();
      else releaseInsets();
      const toggled = await toggleElementFullscreen(getFullscreenDocument(), stageRef.current);
      if (!toggled) throw new Error("当前设备不支持全屏播放");
      setError(null);
    } catch (cause) {
      releaseInsets();
      setError(fullscreenErrorMessage(cause));
    }
  }, [androidInPage, freezeInsets, releaseInsets, setInPageFullscreen, stageRef]);

  useEffect(() => {
    if (!fullscreen) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (exitRequestRef.current?.() !== false) void exit();
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => window.removeEventListener("keydown", exitOnEscape);
  }, [exit, fullscreen]);

  useEffect(() => {
    if (!androidInPage || !fullscreen) return;
    const exitOnBack = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (exitRequestRef.current?.() !== false) void exit();
    };
    window.addEventListener(ANDROID_BACK_EVENT, exitOnBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, exitOnBack);
  }, [androidInPage, exit, fullscreen]);

  useEffect(
    () => () => {
      if (!fullscreenRef.current) return;
      if (isTauriDesktop()) {
        const appWindow = getCurrentWindow();
        void setNativePlayerFullscreen(appWindow, false, nativeSessionRef.current).catch(() => {});
        return;
      }
      if (runningOnAndroidTauri()) {
        fullscreenRef.current = false;
        void setAndroidImmersive(false).catch(() => {});
        return;
      }
      const documentRef = getFullscreenDocument();
      const stage = stageRef.current;
      const element = fullscreenElementFor(documentRef);
      if (!documentRef || !stage || !element || (element !== stage && !stage.contains(element))) {
        return;
      }
      const exitFullscreen =
        documentRef.exitFullscreen ??
        documentRef.webkitExitFullscreen ??
        documentRef.webkitCancelFullScreen;
      if (exitFullscreen) void Promise.resolve(exitFullscreen.call(documentRef)).catch(() => {});
    },
    [stageRef],
  );

  return { fullscreen, nativeLayer: isTauriDesktop() || androidInPage, error, toggle, exit };
}
