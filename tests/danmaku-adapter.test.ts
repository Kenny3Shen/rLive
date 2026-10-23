import { expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DANMAKU_DEFAULT_DURATION_MS,
  DANMAKU_IMAGE_TRACK_SPAN,
  danmakuCommentFromEvent,
  danmuLaneHeight,
  safeDanmuColor,
  updateDanmakuAppearance,
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
  ["大表情", [{ type: "image", image_url: "//i0.hdslb.com/bfs/emote/large.png", large: true }], 2],
  ["普通内联表情", [{ type: "image", image_url: "//i0.hdslb.com/bfs/emote/small.png" }], 1],
] as const)("%s按标记决定占用的轨道数", (_label, spans, expectedLanes) => {
  const comment = danmakuCommentFromEvent({ ...chat, spans }, options);
  expect(comment?.lanes).toBe(expectedLanes);
  expect(comment?.style?.height).toBe(`${expectedLanes * danmuLaneHeight(options.fontSize)}px`);
  expect(comment?.style?.["--rlive-emote-scale"]).toBe(String(expectedLanes));
});

test("大表情只有一条可用车道时退回单轨并恢复原尺寸", () => {
  const comment = danmakuCommentFromEvent(
    {
      ...chat,
      spans: [{ type: "image", image_url: "//i0.hdslb.com/bfs/emote/large.png", large: true }],
    },
    { ...options, laneCount: 1 },
  );
  expect(DANMAKU_IMAGE_TRACK_SPAN).toBe(2);
  expect(comment?.lanes).toBe(1);
  expect(comment?.style?.height).toBe(`${danmuLaneHeight(options.fontSize)}px`);
  expect(comment?.style?.["--rlive-emote-scale"]).toBe("1");
});

test.each([
  ["单轨扩为双轨", 1, 2],
  ["双轨缩回单轨", 2, 1],
] as const)("updateDanmakuAppearance 同步%s的 lanes 与样式", (_label, initialLanes, nextLanes) => {
  const comment = danmakuCommentFromEvent(
    {
      ...chat,
      spans: [{ type: "image", image_url: "//i0.hdslb.com/bfs/emote/large.png", large: true }],
    },
    { ...options, laneCount: initialLanes },
  );
  expect(comment?.lanes).toBe(initialLanes);
  expect(comment?.__rliveMeta.trackSpan).toBe(initialLanes);

  updateDanmakuAppearance(comment!, { ...options, laneCount: nextLanes });

  expect(comment?.lanes).toBe(nextLanes);
  expect(comment?.__rliveMeta.trackSpan).toBe(nextLanes);
  expect(comment?.style?.height).toBe(`${nextLanes * danmuLaneHeight(options.fontSize)}px`);
  expect(comment?.style?.["--rlive-emote-scale"]).toBe(String(nextLanes));
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
