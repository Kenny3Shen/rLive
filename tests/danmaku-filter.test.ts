import { describe, expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  createRepeatMatcher,
  createShieldMatcher,
  isDanmakuEvent,
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

  test("also hides text-shaped entry notices when an upstream labels them as chat", () => {
    const joinedAsChat = event({ content: "小明 进入了直播间" });
    expect(shouldShowInDanmakuPanel(joinedAsChat)).toBe(false);
    expect(shouldShowOnCanvas(joinedAsChat)).toBe(false);
    expect(shouldShowInDanmakuPanel(event({ content: "小 明 进 入 了 直 播 间" }))).toBe(false);
    expect(shouldShowInDanmakuPanel(event({ content: "小明进入直播间了" }))).toBe(false);
    expect(shouldShowOnCanvas(event({ content: "小 明 进 入 直 播 间 了" }))).toBe(false);
    expect(shouldShowInDanmakuPanel(event({ content: "刚进入直播间就收到弹幕" }))).toBe(true);
    expect(shouldShowInDanmakuPanel(event({ content: "我要进房间" }))).toBe(true);
  });

  test("keeps system notices in the list but not in the canvas", () => {
    const notice = event({ kind: "system", content: "弹幕连接断开" });
    expect(shouldShowInDanmakuPanel(notice)).toBe(true);
    expect(shouldShowOnCanvas(notice)).toBe(false);
  });

  test("optionally hides gift messages in both visual feeds", () => {
    const gift = event({ kind: "gift", content: "投喂 火箭 x1" });
    expect(shouldShowInDanmakuPanel(gift)).toBe(true);
    expect(shouldShowOnCanvas(gift)).toBe(true);
    expect(shouldShowInDanmakuPanel(gift, true)).toBe(false);
    expect(shouldShowOnCanvas(gift, true)).toBe(false);
  });

  test("drops malformed native event payloads before UI filters access their fields", () => {
    const malformed = { kind: "chat", user: "观众", content: null, color: null, ts: 1 };
    expect(isDanmakuEvent(malformed)).toBe(false);
    expect(shouldShowInDanmakuPanel(malformed)).toBe(false);
    expect(shouldShowOnCanvas(null)).toBe(false);
  });

  test("normalizes duplicate shield words once for the hot-path matcher", () => {
    const matcher = createShieldMatcher(["  广告  ", "广告", "AD"]);
    expect(matcher(event({ content: "这是广告" }))).toBe(true);
    expect(matcher(event({ content: "正常聊天" }))).toBe(false);
  });

  test("suppresses only consecutive repeated chat messages inside its window", () => {
    const matcher = createRepeatMatcher(true, 5_000);
    expect(matcher(event({ ts: 1_000 }))).toBe(false);
    expect(matcher(event({ ts: 2_000 }))).toBe(true);
    expect(matcher(event({ ts: 8_100 }))).toBe(false);
    expect(matcher(event({ kind: "gift", ts: 8_200 }))).toBe(false);
  });
});
