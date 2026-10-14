import { describe, expect, test } from "bun:test";
import { toggleElementFullscreen } from "../src/features/room/player/useWebPlayer";
import {
  fullscreenPlayerOrientation,
  shouldAutoEnterFullscreenOnLandscape,
  shouldAutoExitFullscreenOnPortrait,
  shouldClearFullscreenRotationProvenance,
} from "../src/features/room/player/androidOrientation";
import { setAndroidImmersive } from "../src/features/room/player/androidImmersive";
import {
  createNativeFullscreenSession,
  restoreNativePlayerMaximizedState,
  setNativePlayerFullscreen,
  type NativePlayerWindow,
} from "../src/shared/nativePlayerFullscreen";

function fakeNativeWindow(maximized = false) {
  let fullscreen = false;
  const calls: string[] = [];
  const appWindow: NativePlayerWindow = {
    isFullscreen: async () => fullscreen,
    isMaximized: async () => maximized,
    setFullscreen: async (next) => {
      calls.push(`fullscreen:${next}`);
      fullscreen = next;
    },
    unmaximize: async () => {
      calls.push("unmaximize");
      maximized = false;
    },
    maximize: async () => {
      calls.push("maximize");
      maximized = true;
    },
  };
  return { appWindow, calls };
}

describe("全屏生命周期", () => {
  test.each(["requestFullscreen", "webkitRequestFullScreen"])("兼容 %s", async (method) => {
    let requested = 0;
    expect(
      await toggleElementFullscreen(
        {},
        {
          [method]: async () => {
            requested += 1;
          },
        },
      ),
    ).toBe(true);
    expect(requested).toBe(1);
  });

  test("退出活动元素；无 API 不伪造成功", async () => {
    let exits = 0;
    expect(
      await toggleElementFullscreen(
        {
          webkitFullscreenElement: {} as Element,
          webkitExitFullscreen: async () => {
            exits += 1;
          },
        },
        {},
      ),
    ).toBe(true);
    expect(exits).toBe(1);
    expect(await toggleElementFullscreen({}, {})).toBe(false);
  });

  test.each([false, true])("原生全屏恢复进入前的最大化状态：%s", async (maximized) => {
    const { appWindow, calls } = fakeNativeWindow(maximized);
    const session = createNativeFullscreenSession();
    await setNativePlayerFullscreen(appWindow, true, session, true);
    await setNativePlayerFullscreen(appWindow, false, session, true);
    expect(calls).toEqual(
      maximized
        ? ["unmaximize", "fullscreen:true", "fullscreen:false", "maximize"]
        : ["fullscreen:true", "fullscreen:false"],
    );
    expect(session.restoreMaximized).toBe(false);
  });

  test("外部退出全屏也恢复最大化，重复恢复无副作用", async () => {
    const { appWindow, calls } = fakeNativeWindow();
    const session = createNativeFullscreenSession();
    session.restoreMaximized = true;
    await restoreNativePlayerMaximizedState(appWindow, session, true);
    await restoreNativePlayerMaximizedState(appWindow, session, true);
    expect(calls).toEqual(["maximize"]);
  });
});

describe("Android 旋转来源", () => {
  test.each([
    [false, true, false, 16 / 9, true],
    [null, true, false, 16 / 9, false],
    [true, true, false, 16 / 9, false],
    [false, true, true, 16 / 9, false],
    [true, false, false, 16 / 9, false],
    [false, true, false, 9 / 16, false],
    [false, true, false, null, false],
  ] as const)(
    "仅竖转横且媒体横屏时进入：%s/%s/%s/%s",
    (wasLandscape, isLandscape, fullscreen, aspectRatio, expected) => {
      expect(
        shouldAutoEnterFullscreenOnLandscape({
          wasLandscape,
          isLandscape,
          fullscreen,
          aspectRatio,
        }),
      ).toBe(expected);
    },
  );

  test.each([
    [true, false, true, true, true],
    [true, false, true, false, false],
    [null, false, true, true, false],
    [false, false, true, true, false],
    [true, true, true, true, false],
    [true, false, false, true, false],
  ] as const)(
    "仅旋转进入的全屏自动退出：%s/%s/%s/%s",
    (wasLandscape, isLandscape, fullscreen, enteredByRotation, expected) => {
      expect(
        shouldAutoExitFullscreenOnPortrait({
          wasLandscape,
          isLandscape,
          fullscreen,
          enteredByRotation,
        }),
      ).toBe(expected);
    },
  );

  test("来源不在进入前一帧清除，退出后清除；旋转进入不锁方向", () => {
    for (const [wasFullscreen, fullscreen, expected] of [
      [false, false, false],
      [true, true, false],
      [true, false, true],
    ]) {
      expect(
        shouldClearFullscreenRotationProvenance({
          wasFullscreen,
          fullscreen,
          enteredByRotation: true,
        }),
      ).toBe(expected);
    }
    expect(fullscreenPlayerOrientation(true, 16 / 9, true)).toBe("auto");
    expect(fullscreenPlayerOrientation(true, 16 / 9, false)).toBe("landscape");
    for (const ratio of [9 / 16, null, NaN, Infinity]) {
      expect(fullscreenPlayerOrientation(true, ratio)).toBe("auto");
    }
  });

  test("沉浸状态由原生桥开启和释放", async () => {
    const calls: unknown[] = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      return undefined as T;
    };
    await setAndroidImmersive(true, invoke);
    await setAndroidImmersive(false, invoke);
    expect(calls).toEqual([
      ["android_player_controls_set_immersive", { immersive: true }],
      ["android_player_controls_set_immersive", { immersive: false }],
    ]);
  });
});
