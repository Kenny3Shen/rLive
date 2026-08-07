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
