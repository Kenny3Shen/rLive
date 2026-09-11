import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoJsPlayerProvider } from "../src/features/room/player/videoJsControls";
import {
  COMPACT_LANDSCAPE_PLAYER_QUERY,
  COMPACT_PLAYER_QUERY,
  PORTRAIT_ORIENTATION_QUERY,
  playerViewportFallbackMatches,
} from "../src/shared/hooks/usePlayerViewport";
import {
  audioOnlyControlPresentation,
  danmakuControlPresentation,
  PlayerControls,
  playerControlsAvoidSystemGestureBar,
  showPlayerSidePanelControl,
  showPlayerVolumeControl,
  showPlayerWebFullscreenControl,
  showSecondaryPlayerControls,
  volumeControlPresentation,
} from "../src/shared/components/player/PlayerControls";
import {
  canStartPlayerEdgeGesture,
  isVerticalPlayerEdgeGesture,
  playerBrightnessShadeOpacity,
  playerEdgeGestureDragExtent,
  playerEdgeGestureForStart,
  playerEdgeGestureIntent,
  playerEdgeGestureValue,
} from "../src/shared/gestures/playerEdgeGesture";
import { PlayerFullscreenLock } from "../src/shared/components/player/PlayerFullscreenLock";
import {
  playerChromeVisible,
  playerStageGesturesEnabled,
  showPlayerFullscreenLock,
} from "../src/shared/components/player/PlayerFullscreenLock";
import {
  isPlayerStageTapMovement,
  playerVolumeForKeyStep,
  PLAYER_STAGE_TAP_MAX_DISTANCE_PX,
  PLAYER_VOLUME_KEY_STEP,
  showRoomSidePanel,
  nextFullscreenLayerToExit,
  shouldUseLargeDanmakuActionMenu,
  shouldRetainRoomSidePanel,
  shouldRunFloatingDanmaku,
  shouldShowRoomDanmakuPanel,
  sidePanelStartsOpen,
  usesPortraitStackLayout,
  isPortraitStackedPlayer,
} from "../src/features/room/PlayerPane";
import {
  PlayerFullscreenHud,
  roomIdentityOverflowDistance,
  showPlayerFullscreenHud,
} from "../src/features/room/PlayerFullscreenHud";
import { RoomIdentityLine } from "../src/shared/components/player/RoomIdentityLine";
import { tooltipTriggerLabel } from "../src/components/videojs/ui/button-tooltip";
import { PLAYER_HUD_BUTTON_CLASS } from "../src/shared/components/player/PlayerControls";
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

  test("the fullscreen lock is available on desktop and mobile fullscreen", () => {
    expect(showPlayerFullscreenLock(true)).toBe(true);
    expect(showPlayerFullscreenLock(false)).toBe(false);
  });

  test("uses streaming-sized desktop and touch targets for the fullscreen lock", () => {
    const html = renderToStaticMarkup(
      createElement(PlayerFullscreenLock, {
        ref: null,
        visible: true,
        locked: false,
        onToggle: () => {},
      }),
    );
    // 独立浮动锁不是控制栏里的紧凑按钮：桌面 48px，粗指针 56px，图标同步放大。
    expect(html).toContain("size-[48px]");
    expect(html).toContain("[@media(pointer:coarse)]:size-[56px]");
    expect(html.split("size-[28px]").length - 1).toBe(1);
    expect(html.split("[@media(pointer:coarse)]:size-[30px]").length - 1).toBe(1);
    expect(html).toContain("rounded-full");
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

  // 时长与双击窗口的判定已交给 Video.js 官方识别器，业务只留识别器不做的位移阈值。
  test("classifies stationary touches as stage taps by movement alone", () => {
    expect(isPlayerStageTapMovement(0, 0)).toBe(true);
    expect(isPlayerStageTapMovement(40, 0)).toBe(false);
    expect(isPlayerStageTapMovement(0, PLAYER_STAGE_TAP_MAX_DISTANCE_PX)).toBe(true);
    expect(isPlayerStageTapMovement(0, PLAYER_STAGE_TAP_MAX_DISTANCE_PX + 1)).toBe(false);
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

  test("back arrow peels one fullscreen layer at a time, native first", () => {
    // 与 Escape 的按键习惯一致：两种全屏叠加时先退原生层，网页全屏留给下一次点击。
    expect(nextFullscreenLayerToExit(true, true)).toBe("fullscreen");
    expect(nextFullscreenLayerToExit(true, false)).toBe("fullscreen");
    expect(nextFullscreenLayerToExit(false, true)).toBe("webFullscreen");
    expect(nextFullscreenLayerToExit(false, false)).toBeNull();
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
});

describe("custom player controls layout", () => {
  test("renders left, center danmaku, and right controls in the specified order", () => {
    const html = renderToStaticMarkup(
      createElement(
        VideoJsPlayerProvider,
        null,
        createElement(PlayerControls, {
          onRefresh: () => {},
          onToggleAudioOnly: () => {},
          centerSlot: createElement("div", { "data-testid": "danmaku-bar" }, "弹幕输入栏"),
          qualities: [{ quality: "1080P" }],
          onQualityChange: () => {},
          onToggleOsd: () => {},
          asrVisible: true,
          onToggleAsr: () => {},
          onToggleWebFullscreen: () => {},
          onToggleFullscreen: () => {},
        }),
      ),
    );

    // 结构包含主控制行与中间弹幕槽
    expect(html).toContain('data-slot="player-extension-controls"');
    expect(html).toContain('data-slot="player-center-slot"');
    expect(html).toContain("弹幕输入栏");

    // 左侧控件：暂停/播放、刷新、音量、仅音频
    expect(html).toContain("group/play"); // PlayButton
    expect(html).toContain("刷新播放");
    expect(html).toContain("仅播声音"); // onToggleAudioOnly (default false -> 仅播声音)

    // 右侧控件：设置、弹幕、字幕、网页全屏、全屏
    expect(html).toContain("播放设置");
    expect(html).toContain("开启弹幕");
    expect(html).toContain("开启语音字幕");
    expect(html).toContain("网页全屏");
    expect(html).toContain("全屏");
  });

  test("leaves picture-in-picture to the native button, which hides itself when unavailable", () => {
    // 画中画交给原生 `PiPButton`：它按 `pipAvailability` 自行决定是否挂载。
    // 没有媒体（SSR）或移动端 WebView 不支持时可用性为 unavailable，整颗按钮不渲染 ——
    // 这正是移动端不再出现一个点了没反应的画中画按钮的原因。
    const html = renderToStaticMarkup(
      createElement(
        VideoJsPlayerProvider,
        null,
        createElement(PlayerControls, { onToggleFullscreen: () => {} }),
      ),
    );
    expect(html).not.toContain("画中画");
    expect(html).not.toContain("group/pip");
  });

  test("uses the same icon geometry as the neighboring media buttons", () => {
    // 原生 PiP 图标默认是 `size-media-icon`（约 16px）；本项目同排播放/静音/全屏
    // 全是 24px。固定到 `size-6`，防止画中画按钮再次视觉偏小。
    const source = readFileSync(
      new URL("../src/components/videojs/ui/pip-button.tsx", import.meta.url),
      "utf8",
    );
    expect(source.match(/"col-start-1 row-start-1 size-6 drop-shadow-media-icon"/g)?.length).toBe(
      2,
    );
    expect(source).not.toContain('"col-start-1 row-start-1 size-media-icon');
  });

  test("keeps the captions button pinned to the left of fullscreen", () => {
    // 直播与点播共用同一个契约：字幕常驻，且永远在全屏按钮左侧。此前点播把字幕塞进
    // `toolsSlot`，于是它渲染在全屏之后 —— 有字幕的片子按钮会跑到全屏右边。
    const html = renderToStaticMarkup(
      createElement(
        VideoJsPlayerProvider,
        null,
        createElement(PlayerControls, {
          onToggleFullscreen: () => {},
          captionsSlot: createElement("div", { "data-testid": "video-subtitles" }, "字幕按钮"),
        }),
      ),
    );
    const fullscreenIdx = html.indexOf("全屏");
    const subtitlesIdx = html.indexOf("字幕按钮");
    expect(subtitlesIdx).toBeGreaterThan(-1);
    expect(fullscreenIdx).toBeGreaterThan(subtitlesIdx);
  });

  test("still places toolsSlot at the very right end of right controls", () => {
    const html = renderToStaticMarkup(
      createElement(
        VideoJsPlayerProvider,
        null,
        createElement(PlayerControls, {
          onToggleFullscreen: () => {},
          toolsSlot: createElement("div", { "data-testid": "player-tools" }, "附加工具"),
        }),
      ),
    );
    const fullscreenIdx = html.indexOf("全屏");
    const toolsIdx = html.indexOf("附加工具");
    expect(fullscreenIdx).toBeGreaterThan(-1);
    expect(toolsIdx).toBeGreaterThan(fullscreenIdx);
  });

  test("fullscreen top HUD buttons use matching player control button styling", () => {
    const html = renderToStaticMarkup(
      createElement(PlayerFullscreenHud, {
        fullscreen: true,
        hasRoomIdentity: true,
        hasActions: true,
        roomTitle: "测试房间",
        onBack: () => {},
        roomActions: [
          {
            id: "share",
            label: "分享",
            icon: () => null,
            onSelect: () => {},
          },
        ],
      }),
    );
    expect(html).toContain("r-live-media-extension-button");
    expect(html).toContain("退出全屏");
  });

  test("every fullscreen HUD button lands on the one shared overlay recipe", () => {
    const html = renderToStaticMarkup(
      createElement(PlayerFullscreenHud, {
        fullscreen: true,
        hasRoomIdentity: true,
        hasActions: true,
        roomTitle: "测试房间",
        onBack: () => {},
        roomActions: [
          { id: "share", label: "分享", icon: () => null, onSelect: () => {} },
        ],
      }),
    );
    // 返回箭头与溢出菜单都必须是 36px 的 MediaButton，一个都不能退回 shadcn 图标按钮。
    expect(html.split("r-live-media-extension-button").length - 1).toBe(2);
    // 白色前景跟着同一份配方走，否则按钮在深色遮罩上会变成深色。
    expect(html.split("text-media-controls-foreground").length - 1).toBe(2);
  });

  test("the shared HUD recipe carries both the media button geometry and the overlay foreground", () => {
    // 录制按钮的 overlay 变体与 IPTV HUD 的返回/关注按钮都直接用这个常量，
    // 它就是「开始录制」不再比邻居小一圈、颜色也不再不一致的唯一保障。
    expect(PLAYER_HUD_BUTTON_CLASS).toContain("r-live-media-extension-button");
    expect(PLAYER_HUD_BUTTON_CLASS).toContain("text-media-controls-foreground");
  });

  test("RoomIdentityLine centers its content within a media control line height", () => {
    const html = renderToStaticMarkup(
      createElement(RoomIdentityLine, {
        title: "测试标题",
        userName: "主播名称",
      }),
    );
    expect(html).toContain("h-media-control");
    expect(html).toContain("items-center");
  });
});

describe("player control tooltips", () => {
  test("falls back to the trigger's accessible name so business buttons never show an empty box", () => {
    // Video.js 原语（暂停、全屏）把文案写进 tooltip context，业务按钮只是普通
    // `<button>`，context 里取到空串 —— 之前只有暂停按钮有文案，其余按钮弹空框。
    expect(tooltipTriggerLabel(createElement("button", { "aria-label": "刷新播放" }))).toBe(
      "刷新播放",
    );
  });

  test("reaches the accessible name through render wrappers", () => {
    // `PopoverTrigger render={<MediaButton aria-label=… />}`：真正的按钮下沉了一层。
    const trigger = createElement("span", {
      render: createElement("button", { "aria-label": "开启字幕" }),
    });
    expect(tooltipTriggerLabel(trigger)).toBe("开启字幕");
  });

  test("leaves the label to Video.js context when the trigger has no accessible name", () => {
    // undefined = 交回 `Tooltip.Label`，暂停/全屏按钮连同快捷键提示照旧。
    expect(tooltipTriggerLabel(createElement("button"))).toBeUndefined();
    expect(tooltipTriggerLabel(createElement("button", { "aria-label": "" }))).toBeUndefined();
    expect(tooltipTriggerLabel("不是元素")).toBeUndefined();
  });

  test("an explicit label still wins over the accessible name", () => {
    expect(
      tooltipTriggerLabel(createElement("button", { "aria-label": "回退" }), "播放设置"),
    ).toBe("播放设置");
  });
});
