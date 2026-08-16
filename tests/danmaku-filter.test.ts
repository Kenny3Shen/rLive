import { describe, expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  aggregatedDanmakuText,
  createDanmakuContentAggregator,
  DANMAKU_CONTENT_AGGREGATION_WINDOW_MS,
  createShieldMatcher,
  isDanmakuEvent,
  shouldShowInDanmakuPanel,
  shouldShowOnFloatingDanmaku,
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
  test("hides noisy room-enter events from both the list and floating overlay", () => {
    const join = event({ kind: "enter", content: "小明进入了直播间" });
    expect(shouldShowInDanmakuPanel(join)).toBe(false);
    expect(shouldShowOnFloatingDanmaku(join)).toBe(false);
  });

  test("also hides text-shaped entry notices when an upstream labels them as chat", () => {
    const joinedAsChat = event({ content: "小明 进入了直播间" });
    expect(shouldShowInDanmakuPanel(joinedAsChat)).toBe(false);
    expect(shouldShowOnFloatingDanmaku(joinedAsChat)).toBe(false);
    expect(shouldShowInDanmakuPanel(event({ content: "小 明 进 入 了 直 播 间" }))).toBe(false);
    expect(shouldShowInDanmakuPanel(event({ content: "小明进入直播间了" }))).toBe(false);
    expect(shouldShowOnFloatingDanmaku(event({ content: "小 明 进 入 直 播 间 了" }))).toBe(false);
    expect(shouldShowInDanmakuPanel(event({ content: "刚进入直播间就收到弹幕" }))).toBe(true);
    expect(shouldShowInDanmakuPanel(event({ content: "我要进房间" }))).toBe(true);
  });

  test("keeps system notices in the list but not in the floating overlay", () => {
    const notice = event({ kind: "system", content: "弹幕连接断开" });
    expect(shouldShowInDanmakuPanel(notice)).toBe(true);
    expect(shouldShowOnFloatingDanmaku(notice)).toBe(false);
  });

  test("optionally hides gift messages in both visual feeds", () => {
    const gift = event({ kind: "gift", content: "投喂 火箭 x1" });
    expect(shouldShowInDanmakuPanel(gift)).toBe(true);
    expect(shouldShowOnFloatingDanmaku(gift)).toBe(true);
    expect(shouldShowInDanmakuPanel(gift, true)).toBe(false);
    expect(shouldShowOnFloatingDanmaku(gift, true)).toBe(false);
  });

  test("drops malformed native event payloads before UI filters access their fields", () => {
    const malformed = { kind: "chat", user: "观众", content: null, color: null, ts: 1 };
    const malformedSelfMarker = {
      kind: "chat",
      user: "观众",
      content: "你好",
      color: null,
      is_self: "yes",
      ts: 1,
    };
    expect(isDanmakuEvent(malformed)).toBe(false);
    expect(isDanmakuEvent(malformedSelfMarker)).toBe(false);
    expect(shouldShowInDanmakuPanel(malformed)).toBe(false);
    expect(shouldShowOnFloatingDanmaku(null)).toBe(false);
  });

  test("normalizes duplicate shield words once for the hot-path matcher", () => {
    const matcher = createShieldMatcher(["  广告  ", "广告", "AD"]);
    expect(matcher(event({ content: "这是广告" }))).toBe(true);
    expect(matcher(event({ content: "正常聊天" }))).toBe(false);
  });

  test("groups matching chat content across senders inside its five-second window", () => {
    const aggregator = createDanmakuContentAggregator(true, 5_000);
    expect(aggregator.aggregate(event({ user: "观众甲", ts: 1_000 }))).toEqual({
      key: "other\u0000你好",
      count: 1,
    });
    // The unrelated line must not break a content-specific grouping window.
    expect(aggregator.aggregate(event({ content: "别的内容", ts: 1_500 })).count).toBe(1);
    expect(aggregator.aggregate(event({ user: "观众乙", ts: 2_000 }))).toEqual({
      key: "other\u0000你好",
      count: 2,
    });
    expect(aggregatedDanmakuText("你好", 2)).toBe("你好 ×2");
    expect(aggregator.aggregate(event({ ts: 8_100 }))).toEqual({
      key: "other\u0000你好",
      count: 1,
    });
    expect(aggregator.aggregate(event({ kind: "gift", ts: 8_200 }))).toEqual({
      key: null,
      count: 1,
    });
  });

  test("uses a ten-second default merge window", () => {
    expect(DANMAKU_CONTENT_AGGREGATION_WINDOW_MS).toBe(10_000);
    const aggregator = createDanmakuContentAggregator(true);

    expect(aggregator.aggregate(event({ ts: 1_000 })).count).toBe(1);
    expect(aggregator.aggregate(event({ ts: 10_500 })).count).toBe(2);
    expect(aggregator.aggregate(event({ ts: 21_000 })).count).toBe(1);
  });

  test("does not combine a local account comment with an identical viewer comment", () => {
    const aggregator = createDanmakuContentAggregator(true, 5_000);
    expect(aggregator.aggregate(event({ is_self: true, ts: 1_000 }))).toEqual({
      key: "self\u0000你好",
      count: 1,
    });
    expect(aggregator.aggregate(event({ is_self: false, ts: 1_100 }))).toEqual({
      key: "other\u0000你好",
      count: 1,
    });
  });
});
