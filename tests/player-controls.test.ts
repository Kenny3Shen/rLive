import { describe, expect, test } from "bun:test";
import { danmakuControlPresentation } from "../src/features/room/PlayerControls";
import { shouldRunDanmakuCanvas } from "../src/features/room/PlayerPane";

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

describe("mobile player drawer", () => {
  test("pauses the obscured danmaku canvas but keeps it on for the desktop rail", () => {
    expect(
      shouldRunDanmakuCanvas({
        danmakuActive: true,
        osdOn: true,
        compactViewport: true,
        sidePanelOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldRunDanmakuCanvas({
        danmakuActive: true,
        osdOn: true,
        compactViewport: false,
        sidePanelOpen: true,
      }),
    ).toBe(true);
  });

  test("respects the user's danmaku visibility switch", () => {
    expect(
      shouldRunDanmakuCanvas({
        danmakuActive: true,
        osdOn: false,
        compactViewport: false,
        sidePanelOpen: false,
      }),
    ).toBe(false);
  });
});
