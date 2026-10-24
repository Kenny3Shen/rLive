import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createPlayButtonActivation } from "../src/components/videojs/lib/play-button-activation";

const root = join(import.meta.dir, "..");

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
  function source(file: string): string {
    return readFileSync(join(root, file), "utf8");
  }

  test("直播、多画面两处与 IPTV 传入业务暂停回调", () => {
    expect(source("src/features/room/PlayerPane.tsx")).toContain(
      "onTogglePause={player.togglePause}",
    );
    expect(
      source("src/features/multi-room/MultiRoomPlayer.tsx").match(
        /onTogglePause=\{player\.togglePause\}/g,
      ),
    ).toHaveLength(2);
    expect(source("src/features/iptv/IptvPlayer.tsx")).toContain("onTogglePause={togglePause}");
  });

  test("点播不接管，继续使用 Video.js 原生 PlayButton", () => {
    expect(source("src/features/video/VideoPlayerPage.tsx")).not.toContain("onTogglePause");
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
