import { describe, expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  createRepeatMatcher,
  shouldShowInDanmakuPanel,
  shouldShowOnCanvas,
} from "../src/features/room/danmaku/filter";

function event(overrides: Partial<DanmakuEvent> = {}): DanmakuEvent {
  return {
    kind: "chat",
    user: "观众",
    content: "你好",
    color: null,
    ts: 1_000,
    ...overrides,
  };
}

describe("danmaku display filter", () => {
  test("hides noisy room-enter events from both the list and canvas", () => {
    const join = event({ kind: "enter", content: "小明进入了直播间" });
    expect(shouldShowInDanmakuPanel(join)).toBe(false);
    expect(shouldShowOnCanvas(join)).toBe(false);
  });

  test("keeps system notices in the list but not in the canvas", () => {
    const notice = event({ kind: "system", content: "弹幕连接断开" });
    expect(shouldShowInDanmakuPanel(notice)).toBe(true);
    expect(shouldShowOnCanvas(notice)).toBe(false);
  });

  test("suppresses only consecutive repeated chat messages inside its window", () => {
    const matcher = createRepeatMatcher(true, 5_000);
    expect(matcher(event({ ts: 1_000 }))).toBe(false);
    expect(matcher(event({ ts: 2_000 }))).toBe(true);
    expect(matcher(event({ ts: 8_100 }))).toBe(false);
    expect(matcher(event({ kind: "gift", ts: 8_200 }))).toBe(false);
  });
});
