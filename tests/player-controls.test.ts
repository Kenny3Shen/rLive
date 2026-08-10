import { describe, expect, test } from "bun:test";
import {
  COMPACT_LANDSCAPE_PLAYER_QUERY,
  COMPACT_PLAYER_QUERY,
  PORTRAIT_ORIENTATION_QUERY,
  playerViewportFallbackMatches,
} from "../src/shared/hooks/usePlayerViewport";
import {
  audioOnlyControlPresentation,
  danmakuControlPresentation,
  playerControlsAvoidSystemGestureBar,
  showPlayerControlsCenterSlot,
  showPlayerSidePanelControl,
  showPlayerVolumeControl,
  showSecondaryPlayerControls,
  volumeControlPresentation,
} from "../src/shared/components/player/PlayerControls";
import {
  canStartPlayerEdgeGesture,
  isPlayerStageDoubleTap,
  isPlayerStageTap,
  isVerticalPlayerEdgeGesture,
  nextRoomSideTabForSwipe,
  playerBrightnessShadeOpacity,
  playerEdgeGestureDragExtent,
  playerEdgeGestureForStart,
  playerEdgeGestureValue,
  PLAYER_STAGE_DOUBLE_TAP_MS,
  showDanmakuComposerInPlayerControls,
  shouldRunDanmakuCanvas,
  sidePanelStartsOpen,
} from "../src/features/room/PlayerPane";
import {
  clampAndroidPlayerControl,
  getAndroidPlayerControls,
  resetAndroidBrightness,
  setAndroidBrightness,
  supportsAndroidNativePlayerControls,
} from "../src/features/room/player/androidPlayerControls";
import { setAndroidPlayerOrientation } from "../src/features/room/player/androidOrientation";

describe("danmaku player control", () => {
  test("shows the enabled state instead of the next action in its icon", () => {
    expect(danmakuControlPresentation(true)).toEqual({
      enabled: true,
      label: "关闭弹幕",
      icon: "message-square-text",
    });
  });

  test("shows the disabled state after danmaku is turned off", () => {
    expect(danmakuControlPresentation(false)).toEqual({
      enabled: false,
      label: "开启弹幕",
      icon: "message-square-off",
    });
  });
});

describe("audio-only player control", () => {
  test("offers audio-only mode while the picture is visible", () => {
    expect(audioOnlyControlPresentation(false)).toEqual({
      enabled: false,
      label: "仅播声音",
      icon: "video-off",
    });
  });

  test("offers picture restoration while audio-only mode is active", () => {
    expect(audioOnlyControlPresentation(true)).toEqual({
      enabled: true,
      label: "恢复画面",
      icon: "headphones",
    });
  });
});

describe("volume player control", () => {
  test("uses the current volume icon and label for audible playback", () => {
    expect(volumeControlPresentation(72, false)).toEqual({
      isMuted: false,
      label: "调节音量（当前 72%）",
      icon: "volume-2",
    });
  });

  test("uses the muted icon for both explicit mute and zero volume", () => {
    expect(volumeControlPresentation(72, true)).toEqual({
      isMuted: true,
      label: "调节音量（当前静音）",
      icon: "volume-x",
    });
    expect(volumeControlPresentation(0, false)).toEqual({
      isMuted: true,
      label: "调节音量（当前静音）",
      icon: "volume-x",
    });
  });
});

describe("mobile player layout", () => {
  test("seeds mobile density without losing the settled orientation", () => {
    expect(playerViewportFallbackMatches(COMPACT_PLAYER_QUERY, true, false)).toBe(true);
    expect(playerViewportFallbackMatches(COMPACT_LANDSCAPE_PLAYER_QUERY, true, false)).toBe(false);
    expect(playerViewportFallbackMatches(PORTRAIT_ORIENTATION_QUERY, true, false)).toBe(true);

    expect(playerViewportFallbackMatches(COMPACT_PLAYER_QUERY, true, true)).toBe(true);
    expect(playerViewportFallbackMatches(COMPACT_LANDSCAPE_PLAYER_QUERY, true, true)).toBe(true);
    expect(playerViewportFallbackMatches(PORTRAIT_ORIENTATION_QUERY, true, true)).toBe(false);

    expect(playerViewportFallbackMatches(COMPACT_PLAYER_QUERY, false, false)).toBe(false);
    expect(playerViewportFallbackMatches(PORTRAIT_ORIENTATION_QUERY, false, true)).toBe(false);
  });

  test("centers the composer in compact chrome only while fullscreen", () => {
    expect(showPlayerControlsCenterSlot(true, false)).toBe(false);
    expect(showPlayerControlsCenterSlot(true, true)).toBe(true);
    expect(showPlayerControlsCenterSlot(false, false)).toBe(true);
  });

  test("moves the portrait composer into player chrome while fullscreen", () => {
    expect(showDanmakuComposerInPlayerControls(true, false)).toBe(false);
    expect(showDanmakuComposerInPlayerControls(true, true)).toBe(true);
    expect(showDanmakuComposerInPlayerControls(false, false)).toBe(true);
  });

  test("keeps secondary controls out of portrait chrome and restores them in landscape", () => {
    expect(showSecondaryPlayerControls(true, true)).toBe(false);
    expect(showSecondaryPlayerControls(true, false)).toBe(true);
    expect(showSecondaryPlayerControls(false, true)).toBe(true);
  });

  test("hides volume and side-panel buttons in mobile fullscreen", () => {
    // Compact landscape still shows them outside fullscreen.
    expect(showPlayerVolumeControl(true, false, false)).toBe(true);
    expect(showPlayerSidePanelControl(true, false, false)).toBe(true);
    // Compact + fullscreen drops both; edge-swipe volume remains.
    expect(showPlayerVolumeControl(true, false, true)).toBe(false);
    expect(showPlayerSidePanelControl(true, false, true)).toBe(false);
    expect(showPlayerVolumeControl(true, true, true)).toBe(false);
    expect(showPlayerSidePanelControl(true, true, true)).toBe(false);
    // Desktop fullscreen keeps them.
    expect(showPlayerVolumeControl(false, false, true)).toBe(true);
    expect(showPlayerSidePanelControl(false, false, true)).toBe(true);
  });

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

describe("mobile player edge gestures", () => {
  test("assigns brightness to the left half and volume to the right half", () => {
    expect(playerEdgeGestureForStart(80, 20, 400)).toBe("brightness");
    expect(playerEdgeGestureForStart(260, 20, 400)).toBe("volume");
  });

  test("maps fallback brightness to a bounded black-overlay opacity", () => {
    expect(playerBrightnessShadeOpacity(100)).toBe(0);
    expect(playerBrightnessShadeOpacity(40)).toBe(0.6);
    expect(playerBrightnessShadeOpacity(0)).toBe(1);
    expect(playerBrightnessShadeOpacity(-20)).toBe(1);
    expect(playerBrightnessShadeOpacity(120)).toBe(0);
  });

  test("requires a deliberate vertical movement and clamps the resulting value", () => {
    expect(isVerticalPlayerEdgeGesture(5, -40)).toBe(true);
    expect(isVerticalPlayerEdgeGesture(48, -28)).toBe(false);
    expect(isVerticalPlayerEdgeGesture(0, 10)).toBe(false);
    expect(playerEdgeGestureDragExtent(320)).toBe(320);
    expect(playerEdgeGestureValue(50, -80, 320)).toBe(75);
    expect(playerEdgeGestureValue(50, 40, 320)).toBe(37.5);
    expect(playerEdgeGestureValue(50, -1, 320)).toBeCloseTo(50.3125);
    expect(playerEdgeGestureValue(50, -1.5, 320)).toBeCloseTo(50.46875);
    expect(playerEdgeGestureValue(98, -400, 320)).toBe(100);
    expect(playerEdgeGestureValue(2, 400, 320)).toBe(0);
  });

  test("uses most of the picture and preserves continuous native values", () => {
    expect(canStartPlayerEdgeGesture(120, 100, 320)).toBe(false);
    expect(canStartPlayerEdgeGesture(126, 100, 320)).toBe(true);
    expect(canStartPlayerEdgeGesture(394, 100, 320)).toBe(true);
    expect(canStartPlayerEdgeGesture(396, 100, 320)).toBe(false);
    expect(clampAndroidPlayerControl(52.375)).toBe(52.375);
    expect(clampAndroidPlayerControl(-5)).toBe(0);
    expect(clampAndroidPlayerControl(101)).toBe(100);
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

  test("normalizes bridge values and sends continuous native commands", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const nativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command.endsWith("get_state")) {
        return { brightness: 48.25 } as T;
      }
      return { value: args?.value } as T;
    };

    await expect(getAndroidPlayerControls(nativeInvoke)).resolves.toEqual({
      brightness: 48.25,
    });
    await expect(setAndroidBrightness(3.125, nativeInvoke)).resolves.toBe(3.125);
    await expect(resetAndroidBrightness(nativeInvoke)).resolves.toBeUndefined();
    // App-level commands, not `plugin:player-controls|…`: a plugin-namespaced
    // invoke is answered by the Rust plugin and never reaches Kotlin.
    expect(calls).toEqual([
      { command: "android_player_controls_get_state", args: undefined },
      { command: "android_player_controls_set_brightness", args: { value: 3.125 } },
      { command: "android_player_controls_reset_brightness", args: undefined },
    ]);
  });

  // Regression: driving STREAM_MUSIC made a room gesture change the device-wide
  // media volume and outlive the room, and its coarse hardware notches swallowed
  // part of the gesture scale. Volume must never reach the native bridge.
  test("exposes no native volume command", async () => {
    const controls = await import("../src/features/room/player/androidPlayerControls");
    expect("setAndroidMediaVolume" in controls).toBe(false);
    expect(Object.keys(controls).filter((name) => /volume/i.test(name))).toEqual([]);
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

describe("overlay chrome system gesture bar allowance", () => {
  test("reserves the inset when the chrome sits on the window's bottom edge", () => {
    expect(playerControlsAvoidSystemGestureBar(false, false)).toBe(true);
  });

  test("drops the inset when content is stacked below the player", () => {
    // Portrait rooms put the danmaku panel under the picture: the gesture bar
    // is below that panel, not below the controls. Reserving it there is the
    // gap that appears on a cold start and hides after a fullscreen round trip.
    expect(playerControlsAvoidSystemGestureBar(false, true)).toBe(false);
  });

  test("keeps the inset in fullscreen, where the player owns the whole window", () => {
    expect(playerControlsAvoidSystemGestureBar(true, true)).toBe(true);
  });
});
