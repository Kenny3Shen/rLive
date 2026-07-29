import { describe, expect, test } from "bun:test";
import { danmakuControlPresentation } from "../src/features/room/PlayerControls";
import {
  canStartPlayerEdgeGesture,
  isVerticalPlayerEdgeGesture,
  nextRoomSideTabForSwipe,
  playerEdgeGestureForStart,
  playerEdgeGestureValue,
  shouldRunDanmakuCanvas,
  sidePanelStartsOpen,
} from "../src/features/room/PlayerPane";
import {
  androidPlayerControlStep,
  getAndroidPlayerControls,
  setAndroidBrightness,
  setAndroidMediaVolume,
  supportsAndroidNativePlayerControls,
} from "../src/features/room/player/androidPlayerControls";

describe("danmaku player control", () => {
  test("shows the enabled state instead of the next action in its icon", () => {
    expect(danmakuControlPresentation(true)).toEqual({
      enabled: true,
      label: "关闭弹幕",
      icon: "captions",
    });
  });

  test("shows the disabled state after danmaku is turned off", () => {
    expect(danmakuControlPresentation(false)).toEqual({
      enabled: false,
      label: "开启弹幕",
      icon: "captions-off",
    });
  });
});

describe("mobile player layout", () => {
  test("opens the danmaku panel by default in portrait, but keeps short landscape viewing-first", () => {
    expect(sidePanelStartsOpen(false)).toBe(true);
    expect(sidePanelStartsOpen(true)).toBe(false);
  });

  test("pauses the danmaku canvas only when an overlay actually obscures the picture", () => {
    expect(
      shouldRunDanmakuCanvas({
        danmakuActive: true,
        osdOn: true,
        sidePanelOverlaysPlayer: true,
      }),
    ).toBe(false);
    expect(
      shouldRunDanmakuCanvas({
        danmakuActive: true,
        osdOn: true,
        sidePanelOverlaysPlayer: false,
      }),
    ).toBe(true);
  });

  test("respects the user's danmaku visibility switch", () => {
    expect(
      shouldRunDanmakuCanvas({
        danmakuActive: true,
        osdOn: false,
        sidePanelOverlaysPlayer: false,
      }),
    ).toBe(false);
  });
});

describe("Android player edge gestures", () => {
  test("assigns brightness to the left half and volume to the right half", () => {
    expect(playerEdgeGestureForStart(80, 20, 400)).toBe("brightness");
    expect(playerEdgeGestureForStart(260, 20, 400)).toBe("volume");
  });

  test("requires a deliberate vertical movement and clamps the resulting value", () => {
    expect(isVerticalPlayerEdgeGesture(5, -40)).toBe(true);
    expect(isVerticalPlayerEdgeGesture(48, -28)).toBe(false);
    expect(isVerticalPlayerEdgeGesture(0, 10)).toBe(false);
    expect(playerEdgeGestureValue(50, -80, 320)).toBe(75);
    expect(playerEdgeGestureValue(98, -400, 320)).toBe(100);
    expect(playerEdgeGestureValue(2, 400, 320)).toBe(0);
  });

  test("starts only in the gesture-safe center band and reports stable 5% values", () => {
    expect(canStartPlayerEdgeGesture(140, 100, 320)).toBe(false);
    expect(canStartPlayerEdgeGesture(180, 100, 320)).toBe(true);
    expect(canStartPlayerEdgeGesture(340, 100, 320)).toBe(true);
    expect(canStartPlayerEdgeGesture(360, 100, 320)).toBe(false);
    expect(androidPlayerControlStep(52)).toBe(50);
    expect(androidPlayerControlStep(53)).toBe(55);
    expect(androidPlayerControlStep(-5)).toBe(0);
    expect(androidPlayerControlStep(101)).toBe(100);
  });
});

describe("Android native player controls", () => {
  test("uses the bridge only inside a Tauri Android client", () => {
    expect(
      supportsAndroidNativePlayerControls({ tauriRuntime: true, platform: "android" }),
    ).toBe(true);
    expect(
      supportsAndroidNativePlayerControls({ tauriRuntime: false, platform: "android" }),
    ).toBe(false);
    expect(
      supportsAndroidNativePlayerControls({ tauriRuntime: true, platform: "desktop" }),
    ).toBe(false);
  });

  test("normalizes bridge values and sends stepped native commands", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const nativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command.endsWith("getState")) {
        return { mediaVolume: 52, brightness: 48 } as T;
      }
      return { value: args?.value } as T;
    };

    await expect(getAndroidPlayerControls(nativeInvoke)).resolves.toEqual({
      mediaVolume: 50,
      brightness: 50,
    });
    await expect(setAndroidMediaVolume(53, nativeInvoke)).resolves.toBe(55);
    await expect(setAndroidBrightness(3, nativeInvoke)).resolves.toBe(5);
    expect(calls).toEqual([
      { command: "plugin:player-controls|getState", args: undefined },
      { command: "plugin:player-controls|setMediaVolume", args: { value: 55 } },
      { command: "plugin:player-controls|setBrightness", args: { value: 5 } },
    ]);
  });
});

describe("mobile room side tabs", () => {
  test("uses left and right swipes to move through every panel, including settings", () => {
    expect(nextRoomSideTabForSwipe("chat", -80, 6)).toBe("sc");
    expect(nextRoomSideTabForSwipe("sc", -80, 6)).toBe("follow");
    expect(nextRoomSideTabForSwipe("follow", -80, 6)).toBe("settings");
    expect(nextRoomSideTabForSwipe("settings", 80, 6)).toBe("follow");
  });

  test("keeps vertical, short and end-of-strip gestures in their current tab", () => {
    expect(nextRoomSideTabForSwipe("chat", -30, 0)).toBeNull();
    expect(nextRoomSideTabForSwipe("chat", -72, 72)).toBeNull();
    expect(nextRoomSideTabForSwipe("chat", 80, 4)).toBeNull();
    expect(nextRoomSideTabForSwipe("settings", -80, 4)).toBeNull();
  });
});
