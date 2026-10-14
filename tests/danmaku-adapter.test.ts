import { expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DANMAKU_DEFAULT_DURATION_MS,
  danmakuCommentFromEvent,
  safeDanmuColor,
} from "../src/features/room/danmaku/danmakuAdapter";

const chat: DanmakuEvent = { kind: "chat", user: "观众", content: "你好", color: null, ts: 1 };
const options = { id: "bullet-1", fontSize: 18, fontStroke: 1.5, opacity: 0.8 };

test.each([
  [{}, "scroll", undefined, "你好"],
  [{ is_self: true }, "top", DANMAKU_DEFAULT_DURATION_MS, "你好"],
  [{ kind: "super_chat", super_chat: { price: 30, duration: 60 } }, "top", 60_000, "【SC】你好"],
] as const)("弹幕映射保留类型与寿命：%j", (overrides, mode, duration, text) => {
  const comment = danmakuCommentFromEvent({ ...chat, ...overrides }, options);
  expect(comment).toMatchObject({ mode, text });
  expect(comment?.duration).toBe(duration);
});

test("空内容不投放", () => {
  expect(danmakuCommentFromEvent({ ...chat, content: "" }, options)).toBeNull();
});

test.each([
  ["#ff0000", "#ff0000"],
  ["rgb(255,0,0)", "rgb(255,0,0)"],
  ["red", "red"],
  ["javascript:alert(1)", "#ffffff"],
  [null, "#ffffff"],
])("颜色白名单：%j", (input, expected) => {
  expect(safeDanmuColor(input)).toBe(expected);
});
