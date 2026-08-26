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
    // 竖屏房间必须保持直立，不能被横过来。
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
    // HTML Fullscreen API 会触发 onShowCustomView，其渲染表面交接正是黑屏闪烁。
    // Android Tauri 绝不能走那条路径。
    expect(usesInPageFullscreen({ tauriRuntime: true, platform: "android" })).toBe(true);
    // 移动浏览器没有原生桥、无法用固定层藏起自身 chrome，
    // 因此保留真正的 Fullscreen API。
    expect(usesInPageFullscreen({ tauriRuntime: false, platform: "android" })).toBe(false);
    // 桌面与 iOS 保持既有路径。
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
    // 我们的 OnBackPressedCallbacks 从 `onWebViewCreate` 注册，晚于 Tauri AppPlugin
    // 注册自己的回调 —— 分发是 LIFO 的，所以我们的先执行。在那里为页面内全屏消费
    // Back 会完全抢占 `rlive:android-back`，连带期望先关闭的 HUD 菜单与音量面板
    // 监听器。只有页面无法自行关闭的原生 custom view 才允许原生处理。
    const mainActivity = await Bun.file(
      new URL(
        "../src-tauri/gen/android/app/src/main/java/com/shenss/rlive/MainActivity.kt",
        import.meta.url,
      ),
    ).text();

    const backHandlers = mainActivity.match(/handleOnBackPressed\(\)/g);
    expect(backHandlers).toHaveLength(2);
    // 两个 Back 处理器都只查询 custom view。沉浸标志保持可读供 `onResume` 使用，
    // 它必须继续隐藏系统栏。
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
    // 未注册的命令在运行时被拒绝，而这条路径刻意吞掉拒绝以保证全屏可用 ——
    // 缺失注册只会表现为设备上状态栏永不隐藏。在这里检查整条链路。
    const [rust, lib, kotlin] = await Promise.all(
      [
        "../src-tauri/src/commands/android_player_controls.rs",
        "../src-tauri/src/lib.rs",
        "../src-tauri/gen/android/app/src/main/java/com/shenss/rlive/RlivePlayerControlsPlugin.kt",
      ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
    );

    // 两个 cfg 分支都定义了它，Android 分支转发给 Kotlin。
    expect(rust.match(/fn android_player_controls_set_immersive/g)).toHaveLength(2);
    expect(rust).toContain('run(controls, "setImmersive"');
    // 已注册进 handler 列表，否则 webview 完全触达不了它。
    expect(lib).toContain("android_player_controls_set_immersive,");
    // 并且它解析到的 Kotlin @Command 确实存在。
    expect(kotlin).toContain("fun setImmersive(invoke: Invoke)");
  });
});
