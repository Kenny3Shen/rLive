import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { getClientPlatform } from "@/shared/clientPlatform";
import { supportsAndroidNativePlayerControls } from "./androidPlayerControls";

/** Orientation lock requested from the Android Activity. */
export type PlayerOrientation = "landscape" | "portrait" | "auto";

type NativeOrientationInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * Orientation lock for a video, decided from the stream's real aspect ratio.
 *
 * The Android WebView reports a `requestedOrientation` hint when a page enters
 * fullscreen, but rLive ignores it: many rooms stream portrait video and
 * honouring the hint turns those on their side. Deciding from the decoded frame
 * size instead auto-rotates 16:9 streams while leaving vertical ones upright.
 * An unknown ratio releases the lock rather than guessing.
 */
export function fullscreenPlayerOrientation(
  fullscreen: boolean,
  aspectRatio: number | null,
): PlayerOrientation {
  if (!fullscreen) return "auto";
  if (aspectRatio == null || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return "auto";
  return aspectRatio > 1 ? "landscape" : "auto";
}

/** Aspect ratio of the decoded stream, or null before metadata arrives. */
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

/** Ask the Android Activity to lock, or release, the player orientation. */
export async function setAndroidPlayerOrientation(
  orientation: PlayerOrientation,
  nativeInvoke: NativeOrientationInvoke = invoke,
): Promise<void> {
  await nativeInvoke("android_player_controls_set_orientation", { orientation });
}

/**
 * Auto-rotate Android fullscreen playback for landscape streams.
 *
 * `MainActivity` declares `orientation|screenSize` in its `configChanges`, so
 * the rotation neither recreates the Activity nor restarts the media session.
 * The lock is always released on exit and on unmount, including when the room
 * route is left straight from fullscreen.
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
      // An older build without the native command must not break fullscreen.
    });

    return () => {
      if (orientation === "auto") return;
      void setAndroidPlayerOrientation("auto").catch(() => {});
    };
  }, [aspectRatio, enabled, fullscreen]);
}
