import { describe, expect, test } from "bun:test";
import {
  fullscreenElementFor,
  toggleElementFullscreen,
  type FullscreenDocument,
} from "../src/features/room/player/useWebPlayer";
import {
  fullscreenPlayerOrientation,
  videoAspectRatio,
} from "../src/features/room/player/androidOrientation";
import {
  setAndroidImmersive,
  usesInPageFullscreen,
} from "../src/features/room/player/androidImmersive";
import {
  createNativeFullscreenSession,
  restoreNativePlayerMaximizedState,
  setNativePlayerFullscreen,
  type NativePlayerWindow,
} from "../src/shared/nativePlayerFullscreen";

function fakeNativeWindow({
  fullscreen = false,
  maximized = false,
}: {
  fullscreen?: boolean;
  maximized?: boolean;
} = {}): { appWindow: NativePlayerWindow; calls: string[] } {
  const calls: string[] = [];
  const appWindow: NativePlayerWindow = {
    async isFullscreen() {
      calls.push("isFullscreen");
      return fullscreen;
    },
    async isMaximized() {
      calls.push("isMaximized");
      return maximized;
    },
    async setFullscreen(next) {
      calls.push(`setFullscreen:${next}`);
      fullscreen = next;
    },
    async unmaximize() {
      calls.push("unmaximize");
      maximized = false;
    },
    async maximize() {
      calls.push("maximize");
      maximized = true;
    },
  };
  return { appWindow, calls };
}

describe("player fullscreen compatibility", () => {
  test("uses the standard Fullscreen API when it is available", async () => {
    let requested = 0;
    const target = {
      requestFullscreen: async () => {
        requested += 1;
      },
    };

    await expect(toggleElementFullscreen({}, target)).resolves.toBe(true);
    expect(requested).toBe(1);
  });

  test("falls back to the WebKit API used by older Android WebViews", async () => {
    let requested = 0;
    const target = {
      webkitRequestFullScreen: async () => {
        requested += 1;
      },
    };

    await expect(toggleElementFullscreen({}, target)).resolves.toBe(true);
    expect(requested).toBe(1);
  });

  test("exits the active standard or prefixed fullscreen element", async () => {
    const active = {} as Element;
    let exits = 0;
    const documentRef: FullscreenDocument = {
      webkitFullscreenElement: active,
      webkitExitFullscreen: async () => {
        exits += 1;
      },
    };

    expect(fullscreenElementFor(documentRef)).toBe(active);
    await expect(toggleElementFullscreen(documentRef, {})).resolves.toBe(true);
    expect(exits).toBe(1);
  });

  test("does not pretend fullscreen succeeded when no API is exposed", async () => {
    await expect(toggleElementFullscreen({}, {})).resolves.toBe(false);
  });
});

describe("Windows native player fullscreen", () => {
  test("clears maximized state before fullscreen and restores it on exit", async () => {
    const { appWindow, calls } = fakeNativeWindow({ maximized: true });
    const session = createNativeFullscreenSession();

    await setNativePlayerFullscreen(appWindow, true, session, true);
    expect(calls).toEqual(["isMaximized", "unmaximize", "isMaximized", "setFullscreen:true"]);
    expect(session.restoreMaximized).toBe(true);

    calls.length = 0;
    await setNativePlayerFullscreen(appWindow, false, session, true);
    expect(calls).toEqual(["setFullscreen:false", "isFullscreen", "maximize"]);
    expect(session.restoreMaximized).toBe(false);
  });

  test("does not alter a window that was not maximized", async () => {
    const { appWindow, calls } = fakeNativeWindow();

    await setNativePlayerFullscreen(appWindow, true, createNativeFullscreenSession(), true);

    expect(calls).toEqual(["isMaximized", "setFullscreen:true"]);
  });

  test("restores maximized state after an external fullscreen exit", async () => {
    const { appWindow, calls } = fakeNativeWindow();
    const session = createNativeFullscreenSession();
    session.restoreMaximized = true;

    await restoreNativePlayerMaximizedState(appWindow, session, true);

    expect(calls).toEqual(["maximize"]);
    expect(session.restoreMaximized).toBe(false);
  });
});

describe("Android fullscreen orientation", () => {
  test("rotates only landscape streams, and only while fullscreen", () => {
    expect(fullscreenPlayerOrientation(true, 16 / 9)).toBe("landscape");
    expect(fullscreenPlayerOrientation(false, 16 / 9)).toBe("auto");
    // Portrait rooms must stay upright instead of being turned on their side.
    expect(fullscreenPlayerOrientation(true, 9 / 16)).toBe("auto");
    expect(fullscreenPlayerOrientation(true, 1)).toBe("auto");
  });

  test("releases the lock when the ratio is unusable", () => {
    expect(fullscreenPlayerOrientation(true, null)).toBe("auto");
    expect(fullscreenPlayerOrientation(true, 0)).toBe("auto");
    expect(fullscreenPlayerOrientation(true, Number.NaN)).toBe("auto");
    expect(fullscreenPlayerOrientation(true, Number.POSITIVE_INFINITY)).toBe("auto");
  });

  test("derives the ratio from the decoded frame size", () => {
    expect(videoAspectRatio({ videoWidth: 1920, videoHeight: 1080 })).toBeCloseTo(16 / 9);
    expect(videoAspectRatio({ videoWidth: 0, videoHeight: 1080 })).toBeNull();
    expect(videoAspectRatio({ videoWidth: 1920, videoHeight: 0 })).toBeNull();
    expect(videoAspectRatio(null)).toBeNull();
  });
});

describe("Android in-page fullscreen", () => {
  test("only the Android Tauri client skips the browser Fullscreen API", () => {
    // The HTML Fullscreen API triggers onShowCustomView, whose render surface
    // handoff is the black flicker. Android Tauri must never take that path.
    expect(usesInPageFullscreen({ tauriRuntime: true, platform: "android" })).toBe(true);
    // A mobile browser has no native bridge and cannot hide its own chrome with
    // a fixed layer, so it keeps the real Fullscreen API.
    expect(usesInPageFullscreen({ tauriRuntime: false, platform: "android" })).toBe(false);
    // Desktop and iOS keep their existing paths.
    expect(usesInPageFullscreen({ tauriRuntime: true, platform: "desktop" })).toBe(false);
    expect(usesInPageFullscreen({ tauriRuntime: true, platform: "ios" })).toBe(false);
  });

  test("requests and releases the native immersive bars", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const fakeInvoke = async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return undefined as T;
    };

    await setAndroidImmersive(true, fakeInvoke);
    await setAndroidImmersive(false, fakeInvoke);

    expect(calls).toEqual([
      { command: "android_player_controls_set_immersive", args: { immersive: true } },
      { command: "android_player_controls_set_immersive", args: { immersive: false } },
    ]);
  });

  test("the Activity leaves Back to the page while immersive", async () => {
    // Our OnBackPressedCallbacks are registered from `onWebViewCreate`, which
    // runs after Tauri's AppPlugin registered its own — and the dispatcher is
    // LIFO, so ours run first. Consuming Back there for the in-page fullscreen
    // would preempt `rlive:android-back` entirely, and with it the HUD menu and
    // volume panel listeners that expect to close first. Only the native custom
    // view, which the page cannot dismiss, may be handled natively.
    const mainActivity = await Bun.file(
      new URL(
        "../src-tauri/gen/android/app/src/main/java/com/shenss/rlive/MainActivity.kt",
        import.meta.url,
      ),
    ).text();

    const backHandlers = mainActivity.match(/handleOnBackPressed\(\)/g);
    expect(backHandlers).toHaveLength(2);
    // Both Back handlers consult the custom view and nothing else. The immersive
    // flag stays readable for `onResume`, which must keep the bars hidden.
    expect(mainActivity.match(/fullscreenChromeClient\?\.exitFullscreen\(\) == true/g))
      .toHaveLength(2);
    const backHandlerBodies = mainActivity
      .split("handleOnBackPressed()")
      .slice(1)
      .map((body) => body.slice(0, body.indexOf("isEnabled = false")));
    expect(backHandlerBodies).toHaveLength(2);
    for (const body of backHandlerBodies) {
      expect(body).not.toContain("isImmersiveActive");
      expect(body).not.toContain("evaluateJavascript");
    }
  });

  test("the immersive command is registered end to end", async () => {
    // An unregistered command rejects at runtime, which this path deliberately
    // swallows so fullscreen still works — so a missing registration would only
    // show up as the status bar never hiding on a device. Check the chain here.
    const [rust, lib, kotlin] = await Promise.all(
      [
        "../src-tauri/src/commands/android_player_controls.rs",
        "../src-tauri/src/lib.rs",
        "../src-tauri/gen/android/app/src/main/java/com/shenss/rlive/RlivePlayerControlsPlugin.kt",
      ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
    );

    // Both cfg branches define it, and the Android one forwards to Kotlin.
    expect(rust.match(/fn android_player_controls_set_immersive/g)).toHaveLength(2);
    expect(rust).toContain('run(controls, "setImmersive"');
    // Registered in the handler list, or the webview cannot reach it at all.
    expect(lib).toContain("android_player_controls_set_immersive,");
    // And the Kotlin @Command it resolves to actually exists.
    expect(kotlin).toContain("fun setImmersive(invoke: Invoke)");
  });
});
