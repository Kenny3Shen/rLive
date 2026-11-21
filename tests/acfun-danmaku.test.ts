import { describe, expect, test } from "bun:test";
import { acfunVideoDanmakuEntries } from "../src/features/acfun/acfunDanmaku";

describe("AcFun VOD danmaku", () => {
  test("按分 P 生成稳定标识并保持时间轴顺序", () => {
    const entries = acfunVideoDanmakuEntries(
      [
        { id: "later", progress: 9_000, mode: 1, size: 25, color: 0xffffff, content: " 后 " },
        { id: "top", progress: 2_000, mode: 5, size: 25, color: 0xff0000, content: "顶部" },
        { id: "bottom", progress: 4_000, mode: 4, size: 25, color: 0x00ff00, content: "底部" },
      ],
      "part-2",
    );

    expect(entries.map((entry) => entry.content)).toEqual(["顶部", "底部", "后"]);
    expect(entries.map((entry) => entry.mode)).toEqual(["top", "bottom", "scroll"]);
    expect(entries.map((entry) => entry.id)).toEqual([
      "part-2:top",
      "part-2:bottom",
      "part-2:later",
    ]);
    expect(entries[0]?.color).toBe("#ff0000");
    expect(entries[2]?.color).toBe("#ffffff");
  });

  test("空内容、重复上游标识与非法颜色不会产生冲突条目", () => {
    const entries = acfunVideoDanmakuEntries(
      [
        { id: "same", progress: 1_000, mode: 1, size: 0, color: -1, content: "第一条" },
        { id: "same", progress: 2_000, mode: 1, size: 0, color: 0, content: "第二条" },
        { id: "", progress: 3_000, mode: 1, size: 0, color: 16_777_216, content: "  " },
      ],
      "",
    );

    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    expect(entries.every((entry) => entry.color === "#ffffff")).toBe(true);
  });
});
