import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notify } from "@/components/ui/toast";
import { getClientPlatform } from "@/shared/clientPlatform";

/** 批量处理快速的指针移动写入，同时保持原生控制的响应性。 */
const NATIVE_CONTROL_THROTTLE_MS = 50;

/**
 * 应用级命令，而不是 `plugin:player-controls|…`。
 *
 * 带插件命名空间的 invoke 由 Rust 插件自己的 invoke handler 应答，
 * 永远到不了 Kotlin 的 `@Command` 方法。Rust 侧改为把这些应用命令
 * 包装插件句柄。
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

/** Tauri 以 `AppError` 对象拒绝，Kotlin 失败则是字符串。 */
function nativeControlErrorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) return error.message;
  return String(error ?? "未知错误");
}

/** 钳制任意输入但不做量化，交给 Android 选择流级别。 */
export function clampAndroidPlayerControl(value: number): number {
  return clampPercent(value);
}

function percentFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? clampAndroidPlayerControl(value)
    : null;
}

/** 保持平台判定为纯函数，便于测试桌面/浏览器兜底路径。 */
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

/** 从原生桥读取系统媒体音量与应用窗口亮度。 */
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

/** 恢复第一次播放器手势之前捕获的 Activity 亮度。 */
export async function resetAndroidBrightness(
  nativeInvoke: NativePlayerControlsInvoke = invoke,
): Promise<void> {
  await nativeInvoke(NATIVE_COMMANDS.resetBrightness);
}

/**
 * 把指针移动写入批量发往 Android 并围栏迟到的应答。滑动立即更新视觉反馈，
 * 原生调用则经由单一队列串行化，
 * 使亮度与音量不会跨 JNI 重排。
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
  /** 每次挂载只弹一次 toast：一次拖拽会产生大量写入，
  否则会刷屏。 */
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
    // 房间变化时可能仍有音量手势排在队列中。在重置亮度之前提交它，
    // 避免丢失系统音量。
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

  // PlayerPane 会把这个对象包含进它发布给 RoomPage 的回调。值未变时保持容器
  // 引用稳定，否则父级更新会立刻创建并发布又一份操作列表。
  return useMemo(
    () => ({
      /** 原生读写成功后为 true。 */
      available,
      /** 即使在 getState 完成之前，Android Tauri 上也为 true。 */
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
