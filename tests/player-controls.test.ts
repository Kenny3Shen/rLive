import { describe, expect, test } from "bun:test";
import { danmakuControlPresentation } from "../src/features/room/PlayerControls";
import {
  canStartPlayerEdgeGesture,
  isPlayerStageDoubleTap,
  isPlayerStageTap,
  isVerticalPlayerEdgeGesture,
  nextRoomSideTabForSwipe,
  playerEdgeGestureDragExtent,
  playerEdgeGestureForStart,
  playerEdgeGestureValue,
  PLAYER_STAGE_DOUBLE_TAP_MS,
  shouldRunDanmakuCanvas,
  sidePanelStartsOpen,
} from "../src/features/room/PlayerPane";
import {
  androidPlayerControlStep,
  getAndroidPlayerControls,
  resetAndroidBrightness,
  setAndroidBrightness,
  setAndroidMediaVolume,
  supportsAndroidNativePlayerControls,
} from "../src/features/room/player/androidPlayerControls";
import { setAndroidPlayerOrientation } from "../src/features/room/player/androidOrientation";

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
    // Simple Live maps a full 0–100 sweep onto half the player height.
    expect(playerEdgeGestureDragExtent(320)).toBe(160);
    expect(playerEdgeGestureValue(50, -80, 320)).toBe(100);
    expect(playerEdgeGestureValue(50, 40, 320)).toBe(25);
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

  test("classifies short stationary touches as stage taps and double taps", () => {
    expect(isPlayerStageTap(0, 0, 120)).toBe(true);
    expect(isPlayerStageTap(40, 0, 120)).toBe(false);
    expect(isPlayerStageTap(0, 0, 500)).toBe(false);
    expect(isPlayerStageDoubleTap(1_000, 1_000 + PLAYER_STAGE_DOUBLE_TAP_MS)).toBe(true);
    expect(isPlayerStageDoubleTap(1_000, 1_000 + PLAYER_STAGE_DOUBLE_TAP_MS + 1)).toBe(false);
    expect(isPlayerStageDoubleTap(0, 1_000)).toBe(false);
  });
});

describe("Android native player controls", () => {
  test("uses the bridge only inside a Tauri Android client", () => {
    expect(supportsAndroidNativePlayerControls({ tauriRuntime: true, platform: "android" })).toBe(
      true,
    );
    expect(supportsAndroidNativePlayerControls({ tauriRuntime: false, platform: "android" })).toBe(
      false,
    );
    expect(supportsAndroidNativePlayerControls({ tauriRuntime: true, platform: "desktop" })).toBe(
      false,
    );
  });

  test("normalizes bridge values and sends stepped native commands", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const nativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command.endsWith("get_state")) {
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
    await expect(resetAndroidBrightness(nativeInvoke)).resolves.toBeUndefined();
    // App-level commands, not `plugin:player-controls|…`: a plugin-namespaced
    // invoke is answered by the Rust plugin and never reaches Kotlin.
    expect(calls).toEqual([
      { command: "android_player_controls_get_state", args: undefined },
      { command: "android_player_controls_set_media_volume", args: { value: 55 } },
      { command: "android_player_controls_set_brightness", args: { value: 5 } },
      { command: "android_player_controls_reset_brightness", args: undefined },
    ]);
  });

  test("asks the Activity to lock and release the fullscreen orientation", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const nativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return undefined as T;
    };

    await setAndroidPlayerOrientation("landscape", nativeInvoke);
    await setAndroidPlayerOrientation("auto", nativeInvoke);
    expect(calls).toEqual([
      {
        command: "android_player_controls_set_orientation",
        args: { orientation: "landscape" },
      },
      {
        command: "android_player_controls_set_orientation",
        args: { orientation: "auto" },
      },
    ]);
  });
});

describe("mobile room side tabs", () => {
  test("uses left and right swipes to move through every panel, including settings", () => {
    expect(nextRoomSideTabForSwipe("chat", -80, 6)).toBe("follow");
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
