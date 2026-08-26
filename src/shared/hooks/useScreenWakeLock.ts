import { useEffect, useRef } from "react";

type WakeLockHandle = {
  sentinel: WakeLockSentinel;
  onRelease: () => void;
};

/**
 * Screen Wake Lock API 由基于 Chromium 的 Android WebView 实现但刻意可选：
 * 桌面浏览器与较旧 WebView 可能根本不暴露它。把能力检查隔离起来，
 * 宿主无法保持屏幕常亮时播放照常继续。
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
    // 应用进入后台时浏览器可能自行释放 sentinel。
  });
}

/**
 * 只在媒体实际播放时保持屏幕唤醒。文档隐藏时浏览器会释放屏幕锁，
 * 因此应用回到前台时申请替代锁。不支持的 WebView 刻意降级为普通播放，
 * 不显示错误。
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
            // sentinel 可能已经被浏览器释放。
          });
          return;
        }

        const onRelease = () => {
          // 锁通常在后台时释放。下方 visibility 监听在文档重新可见时申请新锁，
          // 避免系统拒绝授权时陷入重试循环。
          if (handleRef.current?.sentinel === sentinel) handleRef.current = null;
        };
        handleRef.current = { sentinel, onRelease };
        sentinel.addEventListener("release", onRelease);
      } catch {
        // 浏览器策略、省电模式或较旧 WebView 可能拒绝。播放本身绝不能
        // 因尽力而为的唤醒锁受到影响。
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
