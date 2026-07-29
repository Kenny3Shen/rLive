import { useEffect, useRef } from "react";

type WakeLockHandle = {
  sentinel: WakeLockSentinel;
  onRelease: () => void;
};

/**
 * The Screen Wake Lock API is implemented by Chromium-based Android WebViews
 * but is intentionally optional: desktop browsers and older WebViews may not
 * expose it at all. Keep the capability check isolated so playback continues
 * normally when the host cannot keep the display awake.
 */
export function canUseScreenWakeLock(
  navigatorRef: Pick<Navigator, "wakeLock"> | null | undefined,
): boolean {
  return typeof navigatorRef?.wakeLock?.request === "function";
}

function releaseWakeLock(handle: WakeLockHandle | null): void {
  if (!handle) return;
  handle.sentinel.removeEventListener("release", handle.onRelease);
  void handle.sentinel.release().catch(() => {
    // The browser can release a sentinel itself while the app is backgrounded.
  });
}

/**
 * Keeps a screen awake only while media is actually playing. A browser
 * releases a screen lock whenever its document becomes hidden, so request a
 * replacement when the app returns to the foreground. Unsupported WebViews
 * deliberately degrade to normal playback without showing an error.
 */
export function useScreenWakeLock(playing: boolean): void {
  const handleRef = useRef<WakeLockHandle | null>(null);

  useEffect(() => {
    if (typeof document === "undefined" || typeof navigator === "undefined") return;

    let disposed = false;
    let requestInFlight = false;

    const release = () => {
      const handle = handleRef.current;
      handleRef.current = null;
      releaseWakeLock(handle);
    };

    const request = async () => {
      if (
        disposed ||
        !playing ||
        requestInFlight ||
        handleRef.current ||
        document.visibilityState !== "visible" ||
        !canUseScreenWakeLock(navigator)
      ) {
        return;
      }

      requestInFlight = true;
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (disposed || !playing || document.visibilityState !== "visible") {
          void sentinel.release().catch(() => {
            // The sentinel can already have been released by the browser.
          });
          return;
        }

        const onRelease = () => {
          // A lock is normally released on backgrounding. The visibility
          // listener below requests a fresh one when the document is visible
          // again, avoiding a retry loop if the system declines a lock.
          if (handleRef.current?.sentinel === sentinel) handleRef.current = null;
        };
        handleRef.current = { sentinel, onRelease };
        sentinel.addEventListener("release", onRelease);
      } catch {
        // Browser policy, battery saver, or an older WebView may deny this.
        // Playback itself must never be affected by a best-effort wake lock.
      } finally {
        requestInFlight = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void request();
      } else {
        release();
      }
    };

    if (playing) void request();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      release();
    };
  }, [playing]);
}
