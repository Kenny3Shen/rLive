import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notify } from "@/components/ui/toast";
import { getClientPlatform } from "@/shared/clientPlatform";

/** Batch rapid pointer-move writes while keeping native controls responsive. */
const NATIVE_CONTROL_THROTTLE_MS = 50;

/**
 * App-level commands, not `plugin:player-controls|…`.
 *
 * A plugin-namespaced invoke is answered by the Rust plugin's own invoke
 * handler and never reaches the Kotlin `@Command` methods. The Rust side wraps
 * the plugin handle in these app commands instead.
 */
const NATIVE_COMMANDS = {
  getState: "android_player_controls_get_state",
  setMediaVolume: "android_player_controls_set_media_volume",
  setBrightness: "android_player_controls_set_brightness",
  resetBrightness: "android_player_controls_reset_brightness",
} as const;

export type AndroidPlayerControlsState = {
  mediaVolume: number;
  brightness: number;
};

type AndroidPlayerControlName = "mediaVolume" | "brightness";

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

/** Clamp arbitrary input without quantizing it before Android chooses a stream level. */
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

/** Read the system media volume and app-window brightness from the native bridge. */
export async function getAndroidPlayerControls(
  nativeInvoke: NativePlayerControlsInvoke = invoke,
): Promise<AndroidPlayerControlsState> {
  const response = await nativeInvoke<Record<string, unknown>>(NATIVE_COMMANDS.getState);
  const mediaVolume = percentFrom(response.mediaVolume);
  const brightness = percentFrom(response.brightness);
  if (mediaVolume === null || brightness === null) {
    throw new Error("Android 播放器控制返回了无效状态");
  }
  return { mediaVolume, brightness };
}

async function setAndroidPlayerControl(
  control: "setMediaVolume" | "setBrightness",
  value: number,
  nativeInvoke: NativePlayerControlsInvoke = invoke,
): Promise<number> {
  const expected = clampAndroidPlayerControl(value);
  const response = await nativeInvoke<NativeControlValue>(NATIVE_COMMANDS[control], {
    value: expected,
  });
  return percentFrom(response?.value) ?? expected;
}

export function setAndroidMediaVolume(
  value: number,
  nativeInvoke?: NativePlayerControlsInvoke,
): Promise<number> {
  return setAndroidPlayerControl("setMediaVolume", value, nativeInvoke);
}

export function setAndroidBrightness(
  value: number,
  nativeInvoke?: NativePlayerControlsInvoke,
): Promise<number> {
  return setAndroidPlayerControl("setBrightness", value, nativeInvoke);
}

/** Restore the Activity brightness captured before the first player gesture. */
export async function resetAndroidBrightness(
  nativeInvoke: NativePlayerControlsInvoke = invoke,
): Promise<void> {
  await nativeInvoke(NATIVE_COMMANDS.resetBrightness);
}

/**
 * Batches pointer-move writes to Android and fences late replies. A swipe
 * updates its visual feedback immediately, while native calls are serialized
 * through one queue so brightness and volume cannot reorder across JNI.
 */
export function useAndroidPlayerControls(enabled: boolean, roomSessionKey = "") {
  const [state, setState] = useState<AndroidPlayerControlsState | null>(null);
  const [available, setAvailable] = useState(false);
  const stateRef = useRef<AndroidPlayerControlsState | null>(null);
  const pendingRef = useRef<Partial<Record<AndroidPlayerControlName, number>>>({});
  const timerRef = useRef<number | null>(null);
  const nativeWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const releasePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const requestVersionRef = useRef<Record<AndroidPlayerControlName, number>>({
    mediaVolume: 0,
    brightness: 0,
  });
  const previousMediaVolumeRef = useRef(80);
  const mountedRef = useRef(true);
  /** One toast per mount: a drag emits many writes and would spam otherwise. */
  const reportedWriteErrorRef = useRef(false);

  const replaceState = useCallback((next: AndroidPlayerControlsState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const patchState = useCallback(
    (patch: Partial<AndroidPlayerControlsState>) => {
      const current = stateRef.current;
      if (!current) return;
      replaceState({ ...current, ...patch });
    },
    [replaceState],
  );

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = {};

    for (const [name, value] of Object.entries(pending) as [AndroidPlayerControlName, number][]) {
      const version = ++requestVersionRef.current[name];
      const write = nativeWriteQueueRef.current
        .catch(() => undefined)
        .then(() =>
          name === "mediaVolume" ? setAndroidMediaVolume(value) : setAndroidBrightness(value),
        );
      nativeWriteQueueRef.current = write.then(
        () => undefined,
        () => undefined,
      );
      void write
        .then((actualValue) => {
          if (!mountedRef.current || requestVersionRef.current[name] !== version) return;
          setAvailable(true);
          reportedWriteErrorRef.current = false;
          if (name === "mediaVolume" && actualValue > 0) {
            previousMediaVolumeRef.current = actualValue;
          }
          if (name === "mediaVolume") patchState({ mediaVolume: actualValue });
          else patchState({ brightness: actualValue });
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || requestVersionRef.current[name] !== version) return;
          if (reportedWriteErrorRef.current) return;
          reportedWriteErrorRef.current = true;
          notify.error(
            name === "mediaVolume" ? "调节系统音量失败" : "调节屏幕亮度失败",
            nativeControlErrorText(error),
          );
        });
    }
  }, [patchState]);

  const cancelPendingWrites = useCallback(
    (name?: AndroidPlayerControlName) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (name) {
        delete pendingRef.current[name];
        requestVersionRef.current[name] += 1;
      } else {
        pendingRef.current = {};
        requestVersionRef.current.mediaVolume += 1;
        requestVersionRef.current.brightness += 1;
      }
      if (Object.keys(pendingRef.current).length > 0) {
        timerRef.current = window.setTimeout(flush, NATIVE_CONTROL_THROTTLE_MS);
      }
    },
    [flush],
  );

  const releaseBrightness = useCallback(() => {
    cancelPendingWrites("brightness");
    // A volume gesture may still be queued when the room changes. Commit it
    // before resetting brightness so the system volume cannot be lost.
    flush();
    const release = nativeWriteQueueRef.current
      .catch(() => undefined)
      .then(() => resetAndroidBrightness())
      .catch(() => undefined);
    nativeWriteQueueRef.current = release;
    releasePromiseRef.current = release;
    return release;
  }, [cancelPendingWrites, flush]);

  const queueControl = useCallback(
    (name: AndroidPlayerControlName, value: number): boolean => {
      if (!enabled || !runningOnAndroidTauri()) return false;
      const nextValue = clampAndroidPlayerControl(value);
      if (!stateRef.current) {
        replaceState({
          mediaVolume: name === "mediaVolume" ? nextValue : previousMediaVolumeRef.current,
          brightness: name === "brightness" ? nextValue : 100,
        });
      } else if (name === "mediaVolume") {
        patchState({ mediaVolume: nextValue });
      } else {
        patchState({ brightness: nextValue });
      }
      pendingRef.current[name] = nextValue;
      if (timerRef.current === null) {
        timerRef.current = window.setTimeout(flush, NATIVE_CONTROL_THROTTLE_MS);
      }
      return true;
    },
    [enabled, flush, patchState, replaceState],
  );

  const setMediaVolume = useCallback(
    (value: number): boolean => queueControl("mediaVolume", value),
    [queueControl],
  );

  const setBrightness = useCallback(
    (value: number): boolean => queueControl("brightness", value),
    [queueControl],
  );

  const toggleMediaMute = useCallback((): boolean => {
    if (!enabled || !runningOnAndroidTauri()) return false;
    const current = stateRef.current?.mediaVolume ?? previousMediaVolumeRef.current;
    if (current <= 0) {
      return setMediaVolume(previousMediaVolumeRef.current || 80);
    }
    previousMediaVolumeRef.current = current;
    return setMediaVolume(0);
  }, [enabled, setMediaVolume]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingWrites();
    };
  }, [cancelPendingWrites]);

  useEffect(() => {
    let cancelled = false;
    let shouldResetBrightness = false;
    let readVersion = 0;
    if (!enabled || !runningOnAndroidTauri()) {
      cancelPendingWrites();
      setAvailable(false);
      replaceState(null);
      return () => {
        cancelled = true;
      };
    }

    setAvailable(false);
    replaceState(null);

    const readCurrentState = () => {
      const version = ++readVersion;
      const pendingRelease = releasePromiseRef.current;
      void pendingRelease
        .then(() => getAndroidPlayerControls())
        .then((next) => {
          if (cancelled || readVersion !== version || document.visibilityState !== "visible") {
            return;
          }
          replaceState(next);
          if (next.mediaVolume > 0) previousMediaVolumeRef.current = next.mediaVolume;
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
        readCurrentState();
        return;
      }

      readVersion += 1;
      setAvailable(false);
      replaceState(null);
      shouldResetBrightness = false;
      void releaseBrightness();
    };

    readCurrentState();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (shouldResetBrightness || stateRef.current !== null) {
        void releaseBrightness();
      } else {
        cancelPendingWrites();
      }
    };
  }, [cancelPendingWrites, enabled, releaseBrightness, replaceState, roomSessionKey]);

  const supported = enabled && (available || runningOnAndroidTauri());

  // PlayerPane includes this object in callbacks that it publishes to
  // RoomPage. Keep the container stable when none of its values changed, or
  // that parent update immediately creates and publishes another action list.
  return useMemo(
    () => ({
      /** True after a successful native read/write. */
      available,
      /** True on Android Tauri even before getState finishes. */
      supported,
      state,
      setMediaVolume,
      toggleMediaMute,
      setBrightness,
      flush,
    }),
    [available, flush, setBrightness, setMediaVolume, state, supported, toggleMediaMute],
  );
}
