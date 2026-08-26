import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
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
 * 16:9 的流自动旋转而竖屏流保持直立。未知比例时释放锁而不去猜。
 */
export function fullscreenPlayerOrientation(
  fullscreen: boolean,
  aspectRatio: number | null,
): PlayerOrientation {
  if (!fullscreen) return "auto";
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
 * 横屏流的 Android 全屏自动旋转。
 *
 * `MainActivity` 在 `configChanges` 中声明了 `orientation|screenSize`，
 * 因此旋转既不会重建 Activity 也不会重启媒体会话。
 */
export function useAndroidFullscreenOrientation({
  enabled,
  fullscreen,
  aspectRatio,
}: {
  enabled: boolean;
  fullscreen: boolean;
  aspectRatio: number | null;
}) {
  useEffect(() => {
    if (!enabled || !runningOnAndroidTauri()) return;

    const orientation = fullscreenPlayerOrientation(fullscreen, aspectRatio);
    void setAndroidPlayerOrientation(orientation).catch(() => {
      // 没有该原生命令的旧版本不得破坏全屏功能。
    });

    return () => {
      if (orientation === "auto") return;
      void setAndroidPlayerOrientation("auto").catch(() => {});
    };
  }, [aspectRatio, enabled, fullscreen]);
}
