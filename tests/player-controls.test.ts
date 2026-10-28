import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import {
  playerStageGesturesEnabled,
  playerChromeVisible,
} from "../src/shared/components/player/PlayerFullscreenLock";
import {
  shouldRetainRoomSidePanel,
  shouldShowRoomDanmakuPanel,
  shouldRunFloatingDanmaku,
  nextFullscreenLayerToExit,
  playerVolumeForKeyStep,
  roomPlayerDisplayError,
  usesStackedRoomSidePanel,
} from "../src/features/room/PlayerPane";
import {
  canStartPlayerEdgeGesture,
  playerEdgeGestureIntent,
  playerEdgeGestureValue,
} from "../src/shared/gestures/playerEdgeGesture";
import {
  getAndroidPlayerControls,
  setAndroidBrightness,
  setAndroidMediaVolume,
  resetAndroidBrightness,
} from "../src/features/room/player/androidPlayerControls";
import { setAndroidPlayerOrientation } from "../src/features/room/player/androidOrientation";
import { tooltipTriggerLabel } from "../src/components/videojs/ui/button-tooltip";

describe("播放器交互边界", () => {
  test("锁定同时屏蔽手势与上下控制栏，不销毁已经打开的弹幕侧栏", () => {
    expect(playerStageGesturesEnabled(true)).toBe(false);
    expect(playerChromeVisible(true, true)).toBe(false);
    expect(playerChromeVisible(true, false)).toBe(true);
    const retained = shouldRetainRoomSidePanel(false, true, true);
    expect(shouldRetainRoomSidePanel(retained, false, true)).toBe(true);
    expect(shouldShowRoomDanmakuPanel(false, true, "chat")).toBe(false);
    expect(shouldShowRoomDanmakuPanel(true, false, "chat")).toBe(true);
    expect(shouldRetainRoomSidePanel(false, false, true)).toBe(false);
  });

  test.each([
    [true, true, "fullscreen"],
    [true, false, "fullscreen"],
    [false, true, "webFullscreen"],
    [false, false, null],
  ] as const)("退出全屏逐层处理：%s/%s", (native, web, expected) => {
    expect(nextFullscreenLayerToExit(native, web)).toBe(expected);
  });

  test.each([
    [true, true, false],
    [true, false, true],
    [false, false, false],
  ])("弹幕仅因用户关闭或画面实际被覆盖而暂停：%s/%s", (osdOn, overlay, expected) => {
    expect(
      shouldRunFloatingDanmaku({
        danmakuActive: true,
        osdOn,
        sidePanelOverlaysPlayer: overlay,
      }),
    ).toBe(expected);
  });

  test.each([
    [50, false, 1, 55],
    [100, false, 1, 100],
    [0, false, -1, 0],
    [80, true, 1, 5],
    [80, true, -1, 0],
  ] as const)("音量键从静音起步且有界：%s/%s/%s", (volume, muted, step, expected) => {
    expect(playerVolumeForKeyStep(volume, muted, step)).toBe(expected);
  });

  test("触摸先保留点击，明确纵向后才接手，边缘和数值都有界", () => {
    expect(playerEdgeGestureIntent(6, 6)).toBe("pending");
    expect(playerEdgeGestureIntent(0, 12)).toBe("adjust");
    expect(playerEdgeGestureIntent(12, 0)).toBe("reject");
    expect(canStartPlayerEdgeGesture(120, 100, 320)).toBe(false);
    expect(canStartPlayerEdgeGesture(126, 100, 320)).toBe(true);
    expect(canStartPlayerEdgeGesture(396, 100, 320)).toBe(false);
    expect(playerEdgeGestureValue(50, -1.5, 320)).toBeCloseTo(50.46875);
    expect(playerEdgeGestureValue(98, -400, 320)).toBe(100);
    expect(playerEdgeGestureValue(2, 400, 320)).toBe(0);
  });

  test("直播舞台优先显示恢复会话的终止错误", () => {
    expect(roomPlayerDisplayError(null, "当前线路无法解码", "MediaError: raw")).toEqual({
      code: "play_error",
      message: "当前线路无法解码",
      site: null,
      retryable: true,
    });
    expect(roomPlayerDisplayError(null, null, "MediaError: raw")).toMatchObject({
      code: "play_error",
      message: "MediaError: raw",
    });
    expect(roomPlayerDisplayError({ code: "detail_error" }, "终态错误", "播放器错误")).toEqual({
      code: "detail_error",
    });
  });

  // 平板竖屏曾落在两侧判据之外（宽度越过 767px，指针又是粗指针），于是走桌面并排：
  // 800 宽的列里 16:9 画面只占中间 450px，右侧栏再吃掉 40% 宽度。
  test.each([
    // compact / 矮横屏 / 窄于 64rem -> 侧栏列在舞台下方
    [true, true, true, false, "手机横屏收进抽屉"],
    [true, false, true, true, "手机竖屏"],
    [false, true, false, false, "矮横屏但已越过 767px"],
    [false, false, true, true, "平板竖屏"],
    [false, false, false, false, "桌面与平板横屏并排"],
  ] as const)(
    "侧栏堆叠判据：compact=%s 矮横屏=%s 窄屏=%s -> %s（%s）",
    (compact, compactLandscape, stackedDetails, expected) => {
      expect(
        usesStackedRoomSidePanel(compact, compactLandscape, stackedDetails),
      ).toBe(expected);
    },
  );
});

describe("Android 原生播放器命令", () => {
  test("使用应用级命令，保持连续精度并在写入前钳制音量", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return (
        command.endsWith("get_state")
          ? { mediaVolume: 53.333, brightness: 48.25 }
          : { value: args?.value }
      ) as T;
    };
    expect(await getAndroidPlayerControls(invoke)).toEqual({
      mediaVolume: 53.333,
      brightness: 48.25,
    });
    expect(await setAndroidMediaVolume(52.375, invoke)).toBe(52.375);
    expect(await setAndroidMediaVolume(120, invoke)).toBe(100);
    expect(await setAndroidMediaVolume(-20, invoke)).toBe(0);
    expect(await setAndroidBrightness(3.125, invoke)).toBe(3.125);
    await resetAndroidBrightness(invoke);
    await setAndroidPlayerOrientation("landscape", invoke);
    await setAndroidPlayerOrientation("auto", invoke);
    expect(calls).toEqual([
      { command: "android_player_controls_get_state", args: undefined },
      { command: "android_player_controls_set_media_volume", args: { value: 52.375 } },
      { command: "android_player_controls_set_media_volume", args: { value: 100 } },
      { command: "android_player_controls_set_media_volume", args: { value: 0 } },
      { command: "android_player_controls_set_brightness", args: { value: 3.125 } },
      { command: "android_player_controls_reset_brightness", args: undefined },
      { command: "android_player_controls_set_orientation", args: { orientation: "landscape" } },
      { command: "android_player_controls_set_orientation", args: { orientation: "auto" } },
    ]);
  });
});

test("工具提示透过包装读取可访问名称，显式标签优先，无标签交回 Video.js", () => {
  const wrapped = createElement("span", {
    render: createElement("button", { "aria-label": "字幕" }),
  });
  expect(tooltipTriggerLabel(wrapped)).toBe("字幕");
  expect(tooltipTriggerLabel(wrapped, "设置")).toBe("设置");
  expect(tooltipTriggerLabel(createElement("button"))).toBeUndefined();
});
