import { describe, expect, test } from "bun:test";
import { canNavigateBackInApp, readAppHistoryIndex } from "../src/shared/appHistory";

describe("canNavigateBackInApp", () => {
  test("只有正数历史索引才允许应用内返回", () => {
    expect(canNavigateBackInApp({ idx: 1 })).toBe(true);
    expect(canNavigateBackInApp({ idx: 0 })).toBe(false);
    expect(canNavigateBackInApp({ idx: -1 })).toBe(false);
    expect(canNavigateBackInApp({ idx: "1" })).toBe(false);
    expect(canNavigateBackInApp(null)).toBe(false);
  });
});

describe("readAppHistoryIndex", () => {
  test("Router 仍持有旧 location 时，POP 目标索引不会提前推进", () => {
    const destinationState = { key: "destination", idx: 1 };

    // 浏览器已经改写 history.state，但 Shell 仍以旧 location.key 渲染。
    expect(readAppHistoryIndex(destinationState, "source", 2)).toBe(2);
    // Router location 提交后，索引才可用于新的页面身份与退出方向。
    expect(readAppHistoryIndex(destinationState, "destination", 2)).toBe(1);
  });

  test("同路径 PUSH/POP 只在历史 key 对齐后采用真实索引", () => {
    const pushed = { key: "video-b", idx: 3 };
    const popped = { key: "video-a", idx: 2 };

    expect(readAppHistoryIndex(pushed, "video-a", 2)).toBe(2);
    expect(readAppHistoryIndex(pushed, "video-b", 2)).toBe(3);
    expect(readAppHistoryIndex(popped, "video-b", 3)).toBe(3);
    expect(readAppHistoryIndex(popped, "video-a", 3)).toBe(2);
  });

  test("REPLACE 的新 key 尚未提交时保持原索引", () => {
    const replaced = { key: "replacement", idx: 2 };

    expect(readAppHistoryIndex(replaced, "previous", 2)).toBe(2);
    expect(readAppHistoryIndex(replaced, "replacement", 2)).toBe(2);
  });

  test("缺失 key 按初始 default 记录处理", () => {
    expect(readAppHistoryIndex({ idx: 0 }, "default", 7)).toBe(0);
    expect(readAppHistoryIndex({ key: "", idx: 0 }, "default", 7)).toBe(0);
    expect(readAppHistoryIndex({ idx: 0 }, "other", 7)).toBe(7);
  });

  test("异常 state 与非法索引回退", () => {
    expect(readAppHistoryIndex(null, "entry", 4)).toBe(4);
    expect(readAppHistoryIndex([], "entry", 4)).toBe(4);
    expect(readAppHistoryIndex({ key: 1, idx: 2 }, "entry", 4)).toBe(4);
    expect(readAppHistoryIndex({ key: "entry", idx: -1 }, "entry", 4)).toBe(4);
    expect(readAppHistoryIndex({ key: "entry", idx: 1.5 }, "entry", 4)).toBe(4);
    expect(readAppHistoryIndex({ key: "entry", idx: "2" }, "entry", 4)).toBe(4);
    expect(readAppHistoryIndex({ key: "entry" }, "entry", 4)).toBe(4);
    expect(readAppHistoryIndex({ key: "entry", idx: Number.NaN }, "entry", 4)).toBe(4);
    expect(readAppHistoryIndex({ key: "entry", idx: Number.POSITIVE_INFINITY }, "entry", 4)).toBe(
      4,
    );
  });
});
