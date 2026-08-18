import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  fullscreenElementFor,
  getFullscreenDocument,
  isTauriDesktop,
  toggleElementFullscreen,
} from "@/features/room/player/useWebPlayer";
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

/** Desktop-native/browser fullscreen adapter shared with the live player's UI contract. */
export function useRecordingPlayerFullscreen(stageRef: RefObject<HTMLElement | null>) {
  const nativeSessionRef = useRef(createNativeFullscreenSession());
  const fullscreenRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  fullscreenRef.current = fullscreen;

  useEffect(() => {
    if (isTauriDesktop()) return;
    const sync = () => {
      const stage = stageRef.current;
      const element = fullscreenElementFor(getFullscreenDocument());
      setFullscreen(Boolean(stage && element && (element === stage || stage.contains(element))));
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [stageRef]);

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
            // The native window can already be closing during route teardown.
          }
        };
        await sync();
        unlisten = await appWindow.onResized(() => void sync());
      } catch {
        // Browser previews use the HTML fullscreen effect above.
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
      setError(fullscreenErrorMessage(cause));
    }
  }, [stageRef]);

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

    try {
      const toggled = await toggleElementFullscreen(getFullscreenDocument(), stageRef.current);
      if (!toggled) throw new Error("当前设备不支持全屏播放");
      setError(null);
    } catch (cause) {
      setError(fullscreenErrorMessage(cause));
    }
  }, [stageRef]);

  useEffect(() => {
    if (!fullscreen) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") void exit();
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => window.removeEventListener("keydown", exitOnEscape);
  }, [exit, fullscreen]);

  useEffect(
    () => () => {
      if (!fullscreenRef.current) return;
      if (isTauriDesktop()) {
        const appWindow = getCurrentWindow();
        void setNativePlayerFullscreen(appWindow, false, nativeSessionRef.current).catch(() => {});
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

  return { fullscreen, nativeLayer: isTauriDesktop(), error, toggle, exit };
}
