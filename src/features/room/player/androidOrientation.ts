import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { getClientPlatform } from "@/shared/clientPlatform";
import { supportsAndroidNativePlayerControls } from "./androidPlayerControls";

/** 向 Android Activity 请求的方向锁。 */
export type PlayerOrientation = "landscape" | "portrait" | "auto";

type NativeOrientationInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 根据流的实际宽高比决定视频的方向锁。
 *
 * Android WebView 在页面进入全屏时会上报 `requestedOrientation` 提示，
 * 但 rLive 忽略它：很多房间直播竖屏视频，
 * 遵循提示会把它们横过来。改为从解码后的帧尺寸判断，
 * 16:9 的流自动全屏而竖屏流保持直立。未知比例时释放锁而不去猜。
 *
 * 由旋转带进来的全屏不上锁。`landscape` 锁走的是
 * `SCREEN_ORIENTATION_SENSOR_LANDSCAPE`（见 `RlivePlayerControlsPlugin`），
 * 一上锁 Activity 就被钉在横屏，系统再也不上报竖屏，转回竖屏自动退出便无从触发。
 * 手动点进来的全屏仍要上锁：那时设备还在竖屏，不转过来 16:9 只能占一条。
 */
export function fullscreenPlayerOrientation(
  fullscreen: boolean,
  aspectRatio: number | null,
  enteredByRotation = false,
): PlayerOrientation {
  if (!fullscreen) return "auto";
  if (enteredByRotation) return "auto";
  if (aspectRatio == null || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return "auto";
  return aspectRatio > 1 ? "landscape" : "auto";
}

/** 解码后流的宽高比；元数据到达前为 null。 */
export function videoAspectRatio(
  video: { videoWidth?: number; videoHeight?: number } | null | undefined,
): number | null {
  const width = video?.videoWidth ?? 0;
  const height = video?.videoHeight ?? 0;
  if (!width || !height) return null;
  return width / height;
}

function runningOnAndroidTauri(): boolean {
  return supportsAndroidNativePlayerControls({
    tauriRuntime: isTauri(),
    platform: getClientPlatform(),
  });
}

/** 请求 Android Activity 锁定或释放播放器方向。 */
export async function setAndroidPlayerOrientation(
  orientation: PlayerOrientation,
  nativeInvoke: NativeOrientationInvoke = invoke,
): Promise<void> {
  await nativeInvoke("android_player_controls_set_orientation", { orientation });
}

/**
 * 竖屏 -> 横屏跳变是否应当自动进入全屏。
 *
 * 只认那一次跳变，不按当前方向持续纠正：用户在横屏下手动退出全屏后，持续纠正会
 * 立刻把他拽回全屏，自动行为就变成了不可拒绝的。
 *
 * 与方向锁同源，只认横屏画幅（宽高比 > 1）：竖屏直播间转横屏时不该铺满全屏。
 * 比例未知时不猜，等元数据到了再说。
 */
export function shouldAutoEnterFullscreenOnLandscape({
  wasLandscape,
  isLandscape,
  aspectRatio,
  fullscreen,
}: {
  /** 上一次观察到的方向；`null` 表示还没有基线，首屏方向不算跳变。 */
  wasLandscape: boolean | null;
  isLandscape: boolean;
  aspectRatio: number | null;
  fullscreen: boolean;
}): boolean {
  if (wasLandscape !== false || !isLandscape) return false;
  if (fullscreen) return false;
  if (aspectRatio == null || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return false;
  return aspectRatio > 1;
}

/**
 * 横屏 -> 竖屏跳变是否应当自动退出全屏。
 *
 * 只撤销自动进入的那次全屏。手动点开的全屏由用户自己负责关闭：那种全屏还上着
 * `landscape` 锁，本来也观测不到竖屏；即便观测到了，替用户关掉他亲手打开的全屏
 * 也是越权。
 */
export function shouldAutoExitFullscreenOnPortrait({
  wasLandscape,
  isLandscape,
  fullscreen,
  enteredByRotation,
}: {
  wasLandscape: boolean | null;
  isLandscape: boolean;
  fullscreen: boolean;
  /** 当前这次全屏是否由旋转自动带起来的。 */
  enteredByRotation: boolean;
}): boolean {
  if (wasLandscape !== true || isLandscape) return false;
  return fullscreen && enteredByRotation;
}

/**
 * 这次全屏的「旋转进来」来路是否应当作废。
 *
 * 只认全屏的下降沿。只看当前 `!fullscreen` 会误伤刚请求进入全屏的那一帧——来路已经
 * 记下，播放器还没报告全屏，来路就被擦掉了，方向锁于是按「手动」上 `landscape` 把
 * Activity 钉在横屏，自动退出再也等不到竖屏。
 *
 * 不清掉也不行：下一次在竖屏手动点开的全屏会继承「旋转进来」而不上方向锁，16:9 只
 * 能在竖屏占一条。
 */
export function shouldClearFullscreenRotationProvenance({
  wasFullscreen,
  fullscreen,
  enteredByRotation,
}: {
  /** 上一次观察到的全屏状态。 */
  wasFullscreen: boolean;
  fullscreen: boolean;
  enteredByRotation: boolean;
}): boolean {
  return wasFullscreen && !fullscreen && enteredByRotation;
}

/**
 * Android 上把设备方向和播放器全屏绑在一起。
 *
 * 三件事必须放在一个 hook 里，因为它们共享「这次全屏是不是旋转带起来的」：
 *
 * - 转到横屏自动进入全屏；
 * - 转回竖屏自动退出——仅限自动进来的那次；
 * - 全屏期间的方向锁。
 *
 * 方向锁是这里最容易踩的一环。`landscape` 走 `SCREEN_ORIENTATION_SENSOR_LANDSCAPE`
 * （见 `RlivePlayerControlsPlugin`），一上锁 Activity 就被钉在横屏，系统再也不上报
 * 竖屏，自动退出便永远等不到那次跳变。所以旋转进来的全屏不上锁：它本来就已经横
 * 屏了，不需要锁去转它，不锁才留得住回竖屏的观测。反过来，手动在竖屏下点开的全屏
 * 仍要上锁，否则 16:9 的画面只能在竖屏里占一条。
 *
 * `MainActivity` 在 `configChanges` 里声明了 `orientation|screenSize`，因此旋转既不
 * 重建 Activity 也不重启媒体会话。
 */
export function useAndroidFullscreenOrientation({
  enabled,
  fullscreen,
  aspectRatio,
  isLandscape,
  enterFullscreen,
  exitFullscreen,
}: {
  enabled: boolean;
  fullscreen: boolean;
  aspectRatio: number | null;
  isLandscape: boolean;
  enterFullscreen: () => void;
  exitFullscreen: () => void;
}) {
  // 回调每次渲染都是新函数，放进 ref 才不会让它把 effect 变成「每渲染一次就跑一次」。
  const enterFullscreenRef = useRef(enterFullscreen);
  const exitFullscreenRef = useRef(exitFullscreen);
  useEffect(() => {
    enterFullscreenRef.current = enterFullscreen;
    exitFullscreenRef.current = exitFullscreen;
  }, [enterFullscreen, exitFullscreen]);

  // null 表示还没有可信的方向基线：首屏本来就是横屏（横屏启动、或从别的横屏页面
  // 过来）不算「转到横屏」，否则一进页面就自动全屏。
  const wasLandscapeRef = useRef<boolean | null>(null);
  // 用 state 而不是 ref：方向锁要按它重算，ref 变化不会重跑 effect。
  const [enteredByRotation, setEnteredByRotation] = useState(false);
  // 上一次观察到的全屏状态，供 `shouldClearFullscreenRotationProvenance` 判下降沿。
  const wasFullscreenRef = useRef(fullscreen);

  useEffect(() => {
    if (!enabled || !runningOnAndroidTauri()) {
      wasLandscapeRef.current = null;
      wasFullscreenRef.current = fullscreen;
      return;
    }

    const wasFullscreen = wasFullscreenRef.current;
    wasFullscreenRef.current = fullscreen;
    const wasLandscape = wasLandscapeRef.current;
    wasLandscapeRef.current = isLandscape;

    if (
      shouldAutoEnterFullscreenOnLandscape({ wasLandscape, isLandscape, aspectRatio, fullscreen })
    ) {
      setEnteredByRotation(true);
      enterFullscreenRef.current();
      return;
    }

    if (
      shouldAutoExitFullscreenOnPortrait({
        wasLandscape,
        isLandscape,
        fullscreen,
        enteredByRotation,
      })
    ) {
      setEnteredByRotation(false);
      exitFullscreenRef.current();
      return;
    }

    // 全屏刚结束（返回键、控件，或上面那次自动退出）：这次全屏的来路随之作废。
    if (shouldClearFullscreenRotationProvenance({ wasFullscreen, fullscreen, enteredByRotation })) {
      setEnteredByRotation(false);
    }
  }, [aspectRatio, enabled, enteredByRotation, fullscreen, isLandscape]);

  useEffect(() => {
    if (!enabled || !runningOnAndroidTauri()) return;

    const orientation = fullscreenPlayerOrientation(fullscreen, aspectRatio, enteredByRotation);
    void setAndroidPlayerOrientation(orientation).catch(() => {
      // 没有该原生命令的旧版本不得破坏全屏功能。
    });

    return () => {
      if (orientation === "auto") return;
      void setAndroidPlayerOrientation("auto").catch(() => {});
    };
  }, [aspectRatio, enabled, enteredByRotation, fullscreen]);
}
