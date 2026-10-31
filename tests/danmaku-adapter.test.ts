import { afterEach, expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DANMAKU_DEFAULT_DURATION_MS,
  createDanmuBulletElement,
  danmakuCommentFromEvent,
  danmuLaneHeight,
  safeDanmuColor,
  updateDanmakuAppearance,
} from "../src/features/room/danmaku/danmakuAdapter";

const chat: DanmakuEvent = { kind: "chat", user: "观众", content: "你好", color: null, ts: 1 };
const options = { id: "bullet-1", fontSize: 18, fontStroke: 1.5, opacity: 0.8 };
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");

afterEach(() => {
  if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
  else Reflect.deleteProperty(globalThis, "document");
});

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

test("大表情与普通表情同尺寸且只占一条轨道", () => {
  const large = danmakuCommentFromEvent(
    {
      ...chat,
      spans: [{ type: "image", image_url: "//i0.hdslb.com/bfs/emote/large.png", large: true }],
    },
    options,
  );
  const small = danmakuCommentFromEvent(
    {
      ...chat,
      spans: [{ type: "image", image_url: "//i0.hdslb.com/bfs/emote/small.png" }],
    },
    options,
  );

  expect(large?.style?.height).toBe(`${danmuLaneHeight(options.fontSize)}px`);
  expect(Object.keys(large?.style ?? {}).filter((key) => key.startsWith("--"))).toEqual([]);
  expect(Object.keys(large ?? {}).sort()).toEqual([
    "__rliveMeta",
    "duration",
    "id",
    "mode",
    "render",
    "style",
    "text",
  ]);
  expect(Object.keys(large?.__rliveMeta ?? {}).sort()).toEqual([
    "aggregationCount",
    "aggregationKey",
    "baseText",
    "event",
    "id",
    "spans",
  ]);
  expect(small?.style).toEqual(large?.style);
});

test("updateDanmakuAppearance 只更新字号相关样式，不改变车道或缩放变量", () => {
  const comment = danmakuCommentFromEvent(
    {
      ...chat,
      spans: [{ type: "image", image_url: "//i0.hdslb.com/bfs/emote/large.png", large: true }],
    },
    options,
  )!;

  updateDanmakuAppearance(comment, { ...options, fontSize: 24 });

  expect(comment.style?.height).toBe(`${danmuLaneHeight(24)}px`);
  expect(Object.keys(comment.style ?? {}).filter((key) => key.startsWith("--"))).toEqual([]);
  expect(Object.keys(comment)).not.toContain("lanes");
});

test("大表情图片与普通表情使用同一个类名", () => {
  const comment = danmakuCommentFromEvent(
    {
      ...chat,
      spans: [{ type: "image", image_url: "//i0.hdslb.com/bfs/emote/large.png", large: true }],
    },
    options,
  )!;
  const style = {
    setProperty(): void {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tag: string) {
        return {
          tagName: tag,
          style,
          dataset: {},
          className: "",
          children: [] as unknown[],
          appendChild(child: unknown) {
            this.children.push(child);
            return child;
          },
          insertBefore(child: unknown) {
            this.children.unshift(child);
            return child;
          },
          setAttribute(): void {},
          addEventListener(): void {},
          replaceWith(): void {},
        };
      },
      createTextNode(text: string) {
        return { textContent: text };
      },
    },
  });

  const root = createDanmuBulletElement(comment) as unknown as {
    children: Array<{ children: Array<{ tagName: string; className: string }> }>;
  };
  const content = root.children[0]!;
  const image = content.children.find((child) => child.tagName === "img");

  expect(image?.className).toBe("rlive-danmu-image");
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
