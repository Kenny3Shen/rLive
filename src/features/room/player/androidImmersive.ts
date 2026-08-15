/**
 * Android fullscreen without the WebView's HTML Fullscreen API.
 *
 * Tapping fullscreen used to call `stage.requestFullscreen()`. Chromium answers
 * that by asking `WebChromeClient.onShowCustomView` for a container and
 * *reparenting the rendered content into a brand-new View*. That is a render
 * surface handoff: the old WebView stops drawing before the new View has
 * produced its first frame, so the screen goes fully black for several frames
 * and the picture only reappears once the new surface draws. No amount of
 * same-frame CSS can fix it, because the frames in question belong to a View
 * that has not drawn yet.
 *
 * Desktop Tauri already avoids the browser fullscreen for an unrelated reason
 * (WebView2 will not grow a maximized window past the work area) and fills the
 * screen with an in-page fixed layer instead — `data-fullscreen="true"` on the
 * stage. That path never hands a surface over, so it never black-frames.
 * Android reuses it: the stage becomes the fixed layer and the system bars are
 * hidden through the native plugin rather than as a side effect of the custom
 * view.
 *
 * Back needs nothing extra. `AndroidBackNavigator` already turns the system Back
 * into the cancelable `rlive:android-back` event, and `PlayerPane` cancels it
 * while `mode === "fullscreen"` to run the normal exit — which restores the
 * bars, releases the orientation lock and drops the layer in the right order.
 * Consuming Back in the Activity instead would preempt that event and take the
 * overlay listeners (HUD menu, volume panel) with it.
 *
 * Non-Tauri mobile browsers keep the real Fullscreen API — there is no native
 * bridge there, and a plain `position: fixed` layer cannot hide a browser's own
 * chrome.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getClientPlatform } from "@/shared/clientPlatform";
import { supportsAndroidNativePlayerControls } from "./androidPlayerControls";

const NATIVE_SET_IMMERSIVE = "android_player_controls_set_immersive";

type NativeImmersiveInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Whether this client should fill the screen in-page instead of requesting
 * browser fullscreen.
 *
 * Kept as a pure function of the two inputs so both branches stay testable
 * without a WebView.
 */
export function usesInPageFullscreen({
  tauriRuntime,
  platform,
}: {
  tauriRuntime: boolean;
  platform: ReturnType<typeof getClientPlatform>;
}): boolean {
  return supportsAndroidNativePlayerControls({ tauriRuntime, platform });
}

export function runningOnAndroidTauri(): boolean {
  return usesInPageFullscreen({ tauriRuntime: isTauri(), platform: getClientPlatform() });
}

/**
 * Hides or restores the Android system bars for the in-page fullscreen player.
 *
 * Rejections are the caller's to swallow: an older APK without the command must
 * still get the in-page layer, just with the status bar left visible.
 */
export async function setAndroidImmersive(
  immersive: boolean,
  nativeInvoke: NativeImmersiveInvoke = invoke,
): Promise<void> {
  await nativeInvoke(NATIVE_SET_IMMERSIVE, { immersive });
}
