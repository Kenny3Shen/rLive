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
  showPlayerWebFullscreenControl,
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
  playerChromeVisible,
  playerEdgeGestureDragExtent,
  playerEdgeGestureForStart,
  playerEdgeGestureIntent,
  playerEdgeGestureValue,
  playerStageGesturesEnabled,
  playerVolumeForKeyStep,
  showPlayerFullscreenLock,
  PLAYER_STAGE_DOUBLE_TAP_MS,
  PLAYER_VOLUME_KEY_STEP,
  showDanmakuComposerInPlayerControls,
  showRoomSidePanel,
  stageOwnsRoomTopBar,
  shouldUseLargeDanmakuActionMenu,
  shouldRetainRoomSidePanel,
  shouldRunFloatingDanmaku,
  shouldShowRoomDanmakuPanel,
  sidePanelStartsOpen,
  usesPortraitStackLayout,
  isPortraitStackedPlayer,
} from "../src/features/room/PlayerPane";
import {
  playerHudOnlineLabel,
  roomIdentityOverflowDistance,
  showPlayerFullscreenHud,
} from "../src/features/room/PlayerFullscreenHud";
import {
  clampAndroidPlayerControl,
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
  test("keeps the floating danmaku action menu compact on mobile fullscreen", () => {
    expect(shouldUseLargeDanmakuActionMenu(true, true)).toBe(false);
    expect(shouldUseLargeDanmakuActionMenu(true, false)).toBe(true);
    expect(shouldUseLargeDanmakuActionMenu(false, false)).toBe(false);
  });

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

  test("arrow keys step volume within 0-100", () => {
    expect(playerVolumeForKeyStep(50, false, 1)).toBe(50 + PLAYER_VOLUME_KEY_STEP);
    expect(playerVolumeForKeyStep(50, false, -1)).toBe(50 - PLAYER_VOLUME_KEY_STEP);
    // 到达两端后继续按键必须停在边界，而不是产生越界值。
    expect(playerVolumeForKeyStep(100, false, 1)).toBe(100);
    expect(playerVolumeForKeyStep(0, false, -1)).toBe(0);
  });

  test("volume-up from muted leaves silence in one keypress", () => {
    // 静音时的显示音量可能仍是旧值，按上键必须从 0 起步才能一次出声。
    expect(playerVolumeForKeyStep(80, true, 1)).toBe(PLAYER_VOLUME_KEY_STEP);
    expect(playerVolumeForKeyStep(80, true, -1)).toBe(0);
  });

  test("the fullscreen lock is mobile-fullscreen only", () => {
    expect(showPlayerFullscreenLock(true, true)).toBe(true);
    // 桌面没有误触问题；窗口化时随时可以直接离开。
    expect(showPlayerFullscreenLock(false, true)).toBe(false);
    expect(showPlayerFullscreenLock(true, false)).toBe(false);
  });

  test("locking suspends stage gestures", () => {
    expect(playerStageGesturesEnabled(false)).toBe(true);
    expect(playerStageGesturesEnabled(true)).toBe(false);
  });

  test("locking keeps both chrome layers collapsed while the lock button still sleeps", () => {
    // 未锁定时三层共享同一个唤醒态。
    expect(playerChromeVisible(true, false)).toBe(true);
    expect(playerChromeVisible(false, false)).toBe(false);
    // 锁定期间唤醒只归锁定按钮：手势已屏蔽，chrome 露出来也无从操作。
    expect(playerChromeVisible(true, true)).toBe(false);
    expect(playerChromeVisible(false, true)).toBe(false);
  });

  test("hides volume and side-panel buttons in mobile fullscreen", () => {
    // 紧凑横屏在非全屏时仍显示这两个按钮。
    expect(showPlayerVolumeControl(true, false, false)).toBe(true);
    expect(showPlayerSidePanelControl(true, false, false)).toBe(true);
    // 紧凑 + 全屏去掉两者；边缘滑动音量保留。
    expect(showPlayerVolumeControl(true, false, true)).toBe(false);
    expect(showPlayerSidePanelControl(true, false, true)).toBe(false);
    expect(showPlayerVolumeControl(true, true, true)).toBe(false);
    expect(showPlayerSidePanelControl(true, true, true)).toBe(false);
    // 桌面全屏保留音量。
    expect(showPlayerVolumeControl(false, false, true)).toBe(true);
  });

  test("desktop trades the side-panel toggle for web fullscreen", () => {
    // 桌面窗口化只显示网页全屏：它在收起右侧栏之外还会隐藏房间页的上下栏，
    // 单独的收起按钮成了它的子集。
    expect(showPlayerSidePanelControl(false, false, false)).toBe(false);
    expect(showPlayerWebFullscreenControl(false, false)).toBe(true);
    // 移动端窗口化相反：没有上下栏可让，保留原来的侧栏开关。
    expect(showPlayerSidePanelControl(true, false, false)).toBe(true);
    expect(showPlayerWebFullscreenControl(true, false)).toBe(false);
    // 原生全屏时舞台已独占窗口，网页全屏在两端都会是空操作。
    expect(showPlayerWebFullscreenControl(false, true)).toBe(false);
    expect(showPlayerWebFullscreenControl(true, true)).toBe(false);
  });

  test("web fullscreen yields the side panel without unmounting it", () => {
    expect(showRoomSidePanel(true, false)).toBe(true);
    expect(showRoomSidePanel(true, true)).toBe(false);
    // 本来关着的面板不会被网页全屏打开。
    expect(showRoomSidePanel(false, true)).toBe(false);
  });

  test("both kinds of fullscreen take the room top bar, so both need the HUD", () => {
    // 原生全屏把顶栏盖在 top layer 之下，网页全屏直接卸载它 —— 缺口是同一个。
    expect(stageOwnsRoomTopBar(true, false)).toBe(true);
    expect(stageOwnsRoomTopBar(false, true)).toBe(true);
    // 窗口化时顶栏就在原处，画面内不需要再补一层。
    expect(stageOwnsRoomTopBar(false, false)).toBe(false);
  });

  test("opens the danmaku panel by default in portrait, but keeps short landscape viewing-first", () => {
    expect(sidePanelStartsOpen(false)).toBe(true);
    expect(sidePanelStartsOpen(true)).toBe(false);
  });

  test("the portrait stack marker ignores fullscreen so CSS can lead the re-render", () => {
    // `player.mode` 比 `:fullscreen` 晚一个状态更新。标记必须跨过那一帧保持 true，
    // 否则依赖它的 CSS 会与 React 类一样滞后 —— 它存在的意义就是抢先于那些类。
    expect(usesPortraitStackLayout(true, true)).toBe(true);
    expect(usesPortraitStackLayout(true, false)).toBe(false);
    expect(usesPortraitStackLayout(false, true)).toBe(false);

    // 堆叠层本身仍把屏幕让给全屏。
    expect(isPortraitStackedPlayer(true, false)).toBe(true);
    expect(isPortraitStackedPlayer(true, true)).toBe(false);
    expect(isPortraitStackedPlayer(false, false)).toBe(false);
  });

  test("retains the mounted danmaku panel while mobile fullscreen hides it", () => {
    let retained = shouldRetainRoomSidePanel(false, true, true);
    expect(retained).toBe(true);

    // 进入全屏旋转视口并关闭可见面板。
    retained = shouldRetainRoomSidePanel(retained, false, true);
    expect(retained).toBe(true);
    expect(shouldShowRoomDanmakuPanel(false, true, "chat")).toBe(false);

    // 退出全屏重新露出同一个保活的聊天面板及其积压消息。
    expect(shouldShowRoomDanmakuPanel(true, false, "chat")).toBe(true);

    // 全新的横屏房间仍避免挂载从未打开过的面板。
    expect(shouldRetainRoomSidePanel(false, false, true)).toBe(false);
    expect(shouldRetainRoomSidePanel(false, false, false)).toBe(true);
  });

  test("pauses floating danmaku only when an overlay actually obscures the picture", () => {
    expect(
      shouldRunFloatingDanmaku({
        danmakuActive: true,
        osdOn: true,
        sidePanelOverlaysPlayer: true,
      }),
    ).toBe(false);
    expect(
      shouldRunFloatingDanmaku({
        danmakuActive: true,
        osdOn: true,
        sidePanelOverlaysPlayer: false,
      }),
    ).toBe(true);
  });

  test("respects the user's danmaku visibility switch", () => {
    expect(
      shouldRunFloatingDanmaku({
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

  test("keeps taps on their picture target until a vertical adjustment is recognised", () => {
    // 进行中的触摸接触不能被舞台捕获，否则悬浮 bullet 收不到 pointerup、
    // 打不开它的触摸操作菜单。
    expect(playerEdgeGestureIntent(0, 0)).toBe("pending");
    expect(playerEdgeGestureIntent(6, 6)).toBe("pending");
    expect(playerEdgeGestureIntent(0, 12)).toBe("adjust");
    expect(playerEdgeGestureIntent(12, 0)).toBe("reject");
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
        return { mediaVolume: 53.333, brightness: 48.25 } as T;
      }
      return { value: args?.value } as T;
    };

    await expect(getAndroidPlayerControls(nativeInvoke)).resolves.toEqual({
      mediaVolume: 53.333,
      brightness: 48.25,
    });
    await expect(setAndroidMediaVolume(52.375, nativeInvoke)).resolves.toBe(52.375);
    await expect(setAndroidBrightness(3.125, nativeInvoke)).resolves.toBe(3.125);
    await expect(resetAndroidBrightness(nativeInvoke)).resolves.toBeUndefined();
    // 应用级命令，而不是 `plugin:player-controls|…`：带插件命名空间的 invoke
    // 由 Rust 插件应答，永远到不了 Kotlin。
    expect(calls).toEqual([
      { command: "android_player_controls_get_state", args: undefined },
      { command: "android_player_controls_set_media_volume", args: { value: 52.375 } },
      { command: "android_player_controls_set_brightness", args: { value: 3.125 } },
      { command: "android_player_controls_reset_brightness", args: undefined },
    ]);
  });

  test("clamps native media-volume writes before invoking Android", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const nativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return { value: args?.value } as T;
    };

    await expect(setAndroidMediaVolume(120, nativeInvoke)).resolves.toBe(100);
    await expect(setAndroidMediaVolume(-20, nativeInvoke)).resolves.toBe(0);
    expect(calls).toEqual([
      { command: "android_player_controls_set_media_volume", args: { value: 100 } },
      { command: "android_player_controls_set_media_volume", args: { value: 0 } },
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

describe("fullscreen top HUD", () => {
  test("pans only by the room identity width that exceeds the fixed controls", () => {
    expect(roomIdentityOverflowDistance(640, 420)).toBe(220);
    expect(roomIdentityOverflowDistance(420, 420)).toBe(0);
    expect(roomIdentityOverflowDistance(420.5, 420)).toBe(0);
  });

  test("draws only in fullscreen", () => {
    expect(
      showPlayerFullscreenHud({ fullscreen: false, hasRoomIdentity: true, hasActions: true }),
    ).toBe(false);
    expect(
      showPlayerFullscreenHud({ fullscreen: true, hasRoomIdentity: true, hasActions: false }),
    ).toBe(true);
  });

  test("keeps an action-only HUD, so the overflow menu survives an unnamed room", () => {
    expect(
      showPlayerFullscreenHud({ fullscreen: true, hasRoomIdentity: false, hasActions: true }),
    ).toBe(true);
  });

  test("skips the scrim band when there is neither identity nor actions", () => {
    // 否则没有标题的详情负载会在画面顶部画出一条空渐变带。
    expect(
      showPlayerFullscreenHud({ fullscreen: true, hasRoomIdentity: false, hasActions: false }),
    ).toBe(false);
  });

  test("formats a reported viewer count and hides an unreported one", () => {
    expect(playerHudOnlineLabel(0)).toBe("0");
    expect(playerHudOnlineLabel(1_200)).toBe("1.2k");
    expect(playerHudOnlineLabel(12_345)).toBe("1.2万");
    expect(playerHudOnlineLabel(undefined)).toBeNull();
    expect(playerHudOnlineLabel(Number.NaN)).toBeNull();
    expect(playerHudOnlineLabel(-1)).toBeNull();
  });
});

describe("overlay chrome system gesture bar allowance", () => {
  test("reserves the inset when the chrome sits on the window's bottom edge", () => {
    expect(playerControlsAvoidSystemGestureBar(false, false)).toBe(true);
  });

  test("drops the inset when content is stacked below the player", () => {
    // 竖屏房间把弹幕面板放在画面下方：手势栏在那个面板之下而不是控件之下。
    // 在那里预留空间就是冷启动出现、全屏往返后消失的那道缝隙。
    expect(playerControlsAvoidSystemGestureBar(false, true)).toBe(false);
  });

  test("keeps the inset in fullscreen, where the player owns the whole window", () => {
    expect(playerControlsAvoidSystemGestureBar(true, true)).toBe(true);
  });
});
