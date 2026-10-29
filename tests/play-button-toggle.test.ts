import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createPlayButtonActivation } from "../src/components/videojs/lib/play-button-activation";
import { businessTogglePauseHotkeyOptions } from "../src/components/videojs/skins/shared/toggle-pause-hotkey";

const root = join(import.meta.dir, "..");

function source(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

type TestEvent = {
  target: EventTarget;
  currentTarget: EventTarget;
  key?: string;
  defaultPrevented: boolean;
  preventDefault: () => void;
};

function event(overrides: Partial<TestEvent> = {}): TestEvent {
  const target = {};
  const result: TestEvent = {
    target,
    currentTarget: target,
    key: "",
    defaultPrevented: false,
    preventDefault() {
      result.defaultPrevented = true;
    },
    ...overrides,
  };
  return result;
}

describe("播放按钮业务暂停接管", () => {
  test("鼠标点击只调用一次业务切换并阻止默认动作", () => {
    let calls = 0;
    const activation = createPlayButtonActivation({
      disabled: false,
      onTogglePause: () => {
        calls += 1;
      },
    });
    const click = event();

    activation.onClick(click);

    expect(calls).toBe(1);
    expect(click.defaultPrevented).toBe(true);
  });

  test("Enter 在 keydown 激活一次，Space 在 keyup 激活一次", () => {
    let calls = 0;
    const activation = createPlayButtonActivation({
      disabled: false,
      onTogglePause: () => {
        calls += 1;
      },
    });
    const enterDown = event({ key: "Enter" });
    const spaceDown = event({ key: " " });
    const spaceUp = event({ key: " " });

    activation.onKeyDown(enterDown);
    activation.onKeyDown(spaceDown);
    expect(calls).toBe(1);
    expect(enterDown.defaultPrevented).toBe(true);
    expect(spaceDown.defaultPrevented).toBe(true);

    activation.onKeyUp(spaceUp);
    expect(calls).toBe(2);
    expect(spaceUp.defaultPrevented).toBe(true);
  });

  test("禁用态不调用业务切换，子元素触发的按键也不处理", () => {
    let calls = 0;
    const activation = createPlayButtonActivation({
      disabled: true,
      onTogglePause: () => {
        calls += 1;
      },
    });
    const click = event();
    const enterDown = event({ key: "Enter" });

    activation.onClick(click);
    activation.onKeyDown(enterDown);
    expect(calls).toBe(0);
    expect(click.defaultPrevented).toBe(true);
    expect(enterDown.defaultPrevented).toBe(true);

    const enabled = createPlayButtonActivation({
      disabled: false,
      onTogglePause: () => {
        calls += 1;
      },
    });
    const nestedKeyDown = event({ key: "Enter", currentTarget: {} });
    enabled.onKeyDown(nestedKeyDown);
    expect(calls).toBe(0);
  });
});

describe("播放按钮接线", () => {
  test("直播、多画面与 IPTV 传入业务暂停回调", () => {
    expect(source("src/features/room/PlayerPane.tsx")).toContain(
      "onTogglePause={player.togglePause}",
    );
    // 两处 PlayerControls 与一处 VideoJsContainer（Space/K 快捷键）。
    expect(
      source("src/features/multi-room/MultiRoomPlayer.tsx").match(
        /onTogglePause=\{player\.togglePause\}/g,
      ),
    ).toHaveLength(3);
    expect(source("src/features/iptv/IptvPlayer.tsx")).toContain("onTogglePause={togglePause}");
  });

  test("点播控制条仍用原生 PlayButton，Space/K 改走业务暂停", () => {
    const page = source("src/features/video/VideoPlayerPage.tsx");
    // 只传给 VideoJsContainer（快捷键），不传给控制条的原生 PlayButton。
    expect(page.match(/onTogglePause=/g)).toHaveLength(1);
    expect(page).toContain("onTogglePause={togglePlayback}");
    // 录制回放的 togglePlayback 没有暂停意图记账，保持原生快捷键。
    expect(source("src/features/recording/RecordingPlayer.tsx")).not.toContain("onTogglePause");
  });

  test("点播原生播放按钮起播时清除键盘暂停意图", () => {
    // 原生 PlayButton 不经 togglePlayback；play 事件必须清掉暂停意图，否则播完时连播被拦。
    const page = source("src/features/video/VideoPlayerPage.tsx");
    const onPlay = page.slice(page.indexOf("function onPlay()"), page.indexOf("function onPause()"));
    expect(onPlay).toContain("userPausedRef.current = false;");
  });

  test("包装层仅在业务回调存在时替换激活处理器", () => {
    const playButton = source("src/components/videojs/ui/play-button.tsx");
    expect(playButton).toContain("if (!onTogglePause)");
    expect(playButton).toContain("render={<Button />}");
    expect(playButton).toContain("onClick={activation.onClick}");
    expect(playButton).toContain("onKeyDown={activation.onKeyDown}");
    expect(playButton).toContain("onKeyUp={activation.onKeyUp}");
  });
});

describe("快捷键业务暂停接管", () => {
  test("Space/K 保留 togglePaused action，激活只走一次业务暂停", () => {
    let calls = 0;
    const options = businessTogglePauseHotkeyOptions(() => {
      calls += 1;
    }, "Space");

    expect(options.keys).toBe("Space");
    expect(options.action).toBe("togglePaused");
    expect(options.disabled).toBe(false);

    options.onActivate();
    expect(calls).toBe(1);
  });

  test("直播容器把业务暂停回调透传给快捷键", () => {
    const container = source("src/features/room/player/videoJsControls.tsx");
    expect(container).toContain("onTogglePause={onTogglePause}");
    expect(source("src/components/videojs/skins/live-video/hotkeys.tsx")).toContain(
      "onTogglePause={onTogglePause}",
    );
    const hotkey = source("src/components/videojs/skins/shared/toggle-pause-hotkey.tsx");
    expect(hotkey).toContain("useHotkey(businessTogglePauseHotkeyOptions(");
  });

  test("点播容器把业务暂停回调透传给 PlaybackHotkeys", () => {
    const container = source("src/features/room/player/videoJsControls.tsx");
    expect(container).toContain(
      "<VideoHotkeys onToggleFullscreen={onToggleFullscreen} onTogglePause={onTogglePause} />",
    );
    expect(source("src/components/videojs/skins/video/hotkeys.tsx")).toContain(
      "<PlaybackHotkeys disabled={disabled} onTogglePause={onTogglePause} />",
    );
    const playback = source("src/components/videojs/skins/shared/playback-hotkeys.tsx");
    expect(playback).toContain(
      '<TogglePauseHotkey keys="Space" disabled={disabled} onTogglePause={onTogglePause} />',
    );
    expect(playback).toContain(
      '<TogglePauseHotkey keys="k" disabled={disabled} onTogglePause={onTogglePause} />',
    );
  });
});
