import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { notify } from "@/components/ui/toast";
import { getClientPlatform } from "@/shared/clientPlatform";

/** Batch rapid pointer-move writes while keeping native brightness responsive. */
const NATIVE_CONTROL_THROTTLE_MS = 50;

/**
 * App-level commands, not `plugin:player-controls|…`.
 *
 * A `plugin:<name>|<command>` invoke is answered by the Rust plugin's own
 * invoke handler and never reaches the Kotlin `@Command` methods, so calling
 * the plugin namespace from the webview silently failed. The Rust side wraps
 * the plugin handle in these commands instead.
 *
 * Brightness only. Volume deliberately never crosses this bridge — see
 * [useAndroidPlayerControls].
 */
const NATIVE_COMMANDS = {
  getState: "android_player_controls_get_state",
  setBrightness: "android_player_controls_set_brightness",
  resetBrightness: "android_player_controls_reset_brightness",
} as const;

export type AndroidPlayerControlsState = {
  brightness: number;
};

type NativePlayerControlsInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type NativeControlValue = {
  value?: unknown;
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Tauri rejects with an `AppError` object, Kotlin failures with a string. */
function nativeControlErrorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) return error.message;
  return String(error ?? "未知错误");
}

/** Clamp arbitrary input without quantizing the continuous gesture value. */
export function clampAndroidPlayerControl(value: number): number {
  return clampPercent(value);
}

function percentFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? clampAndroidPlayerControl(value)
    : null;
}

/** Keep the platform test pure so desktop/browser fallback is easy to test. */
export function supportsAndroidNativePlayerControls({
  tauriRuntime,
  platform,
}: {
  tauriRuntime: boolean;
  platform: ReturnType<typeof getClientPlatform>;
}): boolean {
  return tauriRuntime && platform === "android";
}

function runningOnAndroidTauri(): boolean {
  return supportsAndroidNativePlayerControls({
    tauriRuntime: isTauri(),
    platform: getClientPlatform(),
  });
}

/** Read the app-window brightness override from the native bridge. */
export async function getAndroidPlayerControls(
  nativeInvoke: NativePlayerControlsInvoke = invoke,
): Promise<AndroidPlayerControlsState> {
  const response = await nativeInvoke<Record<string, unknown>>(NATIVE_COMMANDS.getState);
  const brightness = percentFrom(response.brightness);
  if (brightness === null) {
    throw new Error("Android 播放器控制返回了无效状态");
  }
  return { brightness };
}

export async function setAndroidBrightness(
  value: number,
  nativeInvoke: NativePlayerControlsInvoke = invoke,
): Promise<number> {
  const expected = clampAndroidPlayerControl(value);
  const response = await nativeInvoke<NativeControlValue>(NATIVE_COMMANDS.setBrightness, {
    value: expected,
  });
  return percentFrom(response?.value) ?? expected;
}

/** Restore the Activity brightness captured before the first player gesture. */
export async function resetAndroidBrightness(
  nativeInvoke: NativePlayerControlsInvoke = invoke,
): Promise<void> {
  await nativeInvoke(NATIVE_COMMANDS.resetBrightness);
}

/**
 * Batches brightness pointer-move writes to Android and fences late replies.
 * A swipe updates its visual feedback immediately, while the native calls are
 * coalesced before crossing IPC rather than sending one call per input event.
 *
 * Volume is not here on purpose. It used to drive `STREAM_MUSIC`, which made a
 * room gesture change the device-wide media volume and persist after leaving
 * the room. Its coarse hardware steps (`getStreamMaxVolume` is typically 15,
 * so ~6.7% per notch) also made adjacent gesture values round to the same
 * notch, so the overlay animated while the audio never moved. Loudness now
 * stays on the web player's `<video>.volume`: app-local, continuous, and
 * released with the player session.
 */
export function useAndroidPlayerControls(enabled: boolean, roomSessionKey = "") {
  const [state, setState] = useState<AndroidPlayerControlsState | null>(null);
  const [available, setAvailable] = useState(false);
  const stateRef = useRef<AndroidPlayerControlsState | null>(null);
  const pendingRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const nativeWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const releasePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const requestVersionRef = useRef(0);
  const mountedRef = useRef(true);
  /** One toast per mount: a drag emits many writes and would spam otherwise. */
  const reportedWriteErrorRef = useRef(false);

  const replaceState = useCallback((next: AndroidPlayerControlsState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const value = pendingRef.current;
    pendingRef.current = null;
    if (value === null) return;

    const version = ++requestVersionRef.current;
    const write = nativeWriteQueueRef.current
      .catch(() => undefined)
      .then(() => setAndroidBrightness(value));
    nativeWriteQueueRef.current = write.then(
      () => undefined,
      () => undefined,
    );
    void write
      .then((actualValue) => {
        if (!mountedRef.current || requestVersionRef.current !== version) return;
        // A successful write proves the native bridge is usable even when the
        // initial getState race had not finished yet.
        setAvailable(true);
        reportedWriteErrorRef.current = false;
        replaceState({ brightness: actualValue });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || requestVersionRef.current !== version) return;
        // Keep optimistic UI for this gesture, but allow a later getState /
        // write to recover. A single failed frame must not permanently demote
        // brightness control back to the CSS shade fallback. The failure still
        // has to be visible: a silently swallowed error is exactly what made a
        // dead native bridge look like a working slider.
        if (reportedWriteErrorRef.current) return;
        reportedWriteErrorRef.current = true;
        notify.error("调节屏幕亮度失败", nativeControlErrorText(error));
      });
  }, [replaceState]);

  const cancelPendingWrite = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    requestVersionRef.current += 1;
  }, []);

  const releaseBrightness = useCallback(() => {
    cancelPendingWrite();
    const release = nativeWriteQueueRef.current
      .catch(() => undefined)
      .then(() => resetAndroidBrightness())
      .catch(() => undefined);
    nativeWriteQueueRef.current = release;
    releasePromiseRef.current = release;
    return release;
  }, [cancelPendingWrite]);

  const setBrightness = useCallback(
    (value: number): boolean => {
      if (!enabled || !runningOnAndroidTauri()) return false;
      const nextValue = clampAndroidPlayerControl(value);
      // Keep the gesture snapshot current without reconciling PlayerPane for
      // every pointer frame. Successful native replies still publish state.
      stateRef.current = { brightness: nextValue };
      pendingRef.current = nextValue;
      if (timerRef.current === null) {
        timerRef.current = window.setTimeout(flush, NATIVE_CONTROL_THROTTLE_MS);
      }
      return true;
    },
    [enabled, flush],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingWrite();
    };
  }, [cancelPendingWrite]);

  useEffect(() => {
    let cancelled = false;
    let shouldResetBrightness = false;
    let readVersion = 0;
    if (!enabled || !runningOnAndroidTauri()) {
      cancelPendingWrite();
      setAvailable(false);
      replaceState(null);
      return () => {
        cancelled = true;
      };
    }

    setAvailable(false);
    replaceState(null);

    const readCurrentBrightness = () => {
      const version = ++readVersion;
      const pendingRelease = releasePromiseRef.current;
      void pendingRelease
        .then(() => getAndroidPlayerControls())
        .then((next) => {
          if (
            cancelled ||
            readVersion !== version ||
            document.visibilityState !== "visible"
          ) {
            return;
          }
          replaceState(next);
          setAvailable(true);
          shouldResetBrightness = true;
        })
        .catch(() => {
          if (cancelled || readVersion !== version) return;
          setAvailable(false);
          replaceState(null);
        });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        readCurrentBrightness();
        return;
      }

      // MainActivity.onPause also releases the override. Clear the optimistic
      // browser snapshot here so returning to the room never starts the next
      // gesture from a brightness value that no longer exists natively.
      readVersion += 1;
      setAvailable(false);
      replaceState(null);
      shouldResetBrightness = false;
      void releaseBrightness();
    };

    readCurrentBrightness();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      // A direct room-to-room route change can reuse PlayerPane. Keying this
      // effect by roomSessionKey makes that route transition release the old
      // room's brightness just as a full unmount does. releaseBrightness waits
      // for an in-flight native write before resetting, so a late reply cannot
      // reapply the override after cleanup.
      if (shouldResetBrightness || stateRef.current !== null) {
        void releaseBrightness();
      } else {
        cancelPendingWrite();
      }
    };
  }, [
    cancelPendingWrite,
    enabled,
    releaseBrightness,
    replaceState,
    roomSessionKey,
  ]);

  return {
    /** True after a successful native read/write. */
    available,
    /** True on Android Tauri even before getState finishes. */
    supported: enabled && (available || runningOnAndroidTauri()),
    state,
    setBrightness,
    flush,
  };
}
