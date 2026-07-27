import { describe, expect, test } from "bun:test";
import { danmakuControlPresentation } from "../src/features/room/PlayerControls";

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
