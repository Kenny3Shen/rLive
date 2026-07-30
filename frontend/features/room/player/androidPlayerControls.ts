import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClientPlatform } from "@/shared/clientPlatform";

/** Match Simple Live's deliberate, low-noise 5% gesture increments. */
export const ANDROID_PLAYER_CONTROL_STEP = 5;
/** Batch rapid pointer-move writes; version fencing drops stale replies. */
const NATIVE_CONTROL_THROTTLE_MS = 200;

export type AndroidPlayerControlsState = {
  mediaVolume: number;
  brightness: number;
};

type AndroidPlayerControlName = keyof AndroidPlayerControlsState;
type NativePlayerControlsInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type NativeControlValue = {
  value?: unknown;
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Clamp arbitrary input to an Android player gesture step. */
export function androidPlayerControlStep(value: number): number {
  const clamped = clampPercent(value);
  return clampPercent(
    Math.round(clamped / ANDROID_PLAYER_CONTROL_STEP) * ANDROID_PLAYER_CONTROL_STEP,
  );
}

function percentFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? androidPlayerControlStep(value)
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

/** Read the Android media volume and app-window brightness from the native bridge. */
export async function getAndroidPlayerControls(
  nativeInvoke: NativePlayerControlsInvoke = invoke,
): Promise<AndroidPlayerControlsState> {
  const response = await nativeInvoke<Record<string, unknown>>("plugin:player-controls|getState");
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
  const expected = androidPlayerControlStep(value);
  const response = await nativeInvoke<NativeControlValue>(`plugin:player-controls|${control}`, {
    value: expected,
  });
  // Different Android devices expose different discrete media-volume steps.
  // Keep the gesture UI on its stable 5% scale even when the framework rounds
  // a stream level to e.g. 47% internally.
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
  await nativeInvoke("plugin:player-controls|resetBrightness");
}

type PendingControls = Partial<Record<AndroidPlayerControlName, number>>;

/**
 * Batches pointer-move writes to Android and fences late replies. A swipe
 * updates its visual feedback immediately, while the native calls are capped
 * at roughly one per display frame rather than one per input event.
 */
export function useAndroidPlayerControls(enabled: boolean) {
  const [state, setState] = useState<AndroidPlayerControlsState | null>(null);
  const [available, setAvailable] = useState(false);
  const stateRef = useRef<AndroidPlayerControlsState | null>(null);
  const pendingRef = useRef<PendingControls>({});
  const timerRef = useRef<number | null>(null);
  const requestVersionRef = useRef<Record<AndroidPlayerControlName, number>>({
    mediaVolume: 0,
    brightness: 0,
  });
  const previousMediaVolumeRef = useRef(80);
  const mountedRef = useRef(true);

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

    (Object.entries(pending) as [AndroidPlayerControlName, number][]).forEach(([name, value]) => {
      const version = ++requestVersionRef.current[name];
      const write = name === "mediaVolume" ? setAndroidMediaVolume : setAndroidBrightness;
      void write(value)
        .then((actualValue) => {
          if (!mountedRef.current || requestVersionRef.current[name] !== version) return;
          // A successful write proves the native bridge is usable even when the
          // initial getState race had not finished yet.
          setAvailable(true);
          patchState({ [name]: actualValue });
        })
        .catch(() => {
          if (!mountedRef.current || requestVersionRef.current[name] !== version) return;
          // Keep optimistic UI for this gesture, but allow a later getState /
          // write to recover. A single failed frame must not permanently
          // demote Android volume control back to the HTML <video> element.
        });
    });
  }, [patchState]);

  const queue = useCallback(
    (name: AndroidPlayerControlName, value: number): boolean => {
      // System media volume is the only correct Android control surface.
      // Queue writes as soon as we are on a Tauri Android host, even before
      // the first getState resolves, so a first swipe still changes STREAM_MUSIC.
      if (!enabled || !runningOnAndroidTauri()) return false;
      const nextValue = androidPlayerControlStep(value);
      if (!stateRef.current) {
        const seed: AndroidPlayerControlsState = {
          mediaVolume: name === "mediaVolume" ? nextValue : 80,
          brightness: name === "brightness" ? nextValue : 50,
        };
        replaceState(seed);
      } else {
        patchState({ [name]: nextValue });
      }
      pendingRef.current[name] = nextValue;
      if (timerRef.current === null) {
        timerRef.current = window.setTimeout(flush, NATIVE_CONTROL_THROTTLE_MS);
      }
      return true;
    },
    [enabled, flush, patchState, replaceState],
  );

  const setMediaVolume = useCallback((value: number) => queue("mediaVolume", value), [queue]);
  const setBrightness = useCallback((value: number) => queue("brightness", value), [queue]);

  const toggleMediaMute = useCallback((): boolean => {
    if (!enabled || !runningOnAndroidTauri()) return false;
    const mediaVolume = stateRef.current?.mediaVolume ?? previousMediaVolumeRef.current ?? 80;
    if (mediaVolume <= 0) {
      return setMediaVolume(previousMediaVolumeRef.current || 80);
    }
    previousMediaVolumeRef.current = mediaVolume;
    return setMediaVolume(0);
  }, [enabled, setMediaVolume]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let shouldResetBrightness = false;
    if (!enabled || !runningOnAndroidTauri()) {
      setAvailable(false);
      replaceState(null);
      return () => {
        cancelled = true;
      };
    }

    void getAndroidPlayerControls()
      .then((next) => {
        if (cancelled) return;
        replaceState(next);
        previousMediaVolumeRef.current = next.mediaVolume || previousMediaVolumeRef.current;
        setAvailable(true);
        shouldResetBrightness = true;
      })
      .catch(() => {
        if (cancelled) return;
        setAvailable(false);
        replaceState(null);
      });

    return () => {
      cancelled = true;
      // Leaving the player must not leave the Activity stuck at a gesture
      // brightness; Simple Live restores the prior window value on exit.
      if (shouldResetBrightness || stateRef.current !== null) {
        void resetAndroidBrightness().catch(() => {
          // Native bridge may already be torn down with the room route.
        });
      }
    };
  }, [enabled, replaceState]);

  return {
    /** True after a successful native read/write. Volume setters still work earlier. */
    available,
    /** True on Android Tauri even before getState finishes — volume must hit STREAM_MUSIC. */
    supported: enabled && (available || runningOnAndroidTauri()),
    state,
    setMediaVolume,
    setBrightness,
    toggleMediaMute,
    flush,
  };
}
