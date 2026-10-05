import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentLevelBadge } from "../src/features/video/CommentLevelBadge";

function render(level: number) {
  return renderToStaticMarkup(createElement(CommentLevelBadge, { level }));
}

describe("评论等级标识", () => {
  test("Lv1–Lv6 各自使用独立语义色，并保留文字与无障碍名称", () => {
    const classes = new Set<string>();
    for (let level = 1; level <= 6; level += 1) {
      const html = render(level);
      expect(html).toContain(`Lv${level}`);
      expect(html).toContain(`aria-label="用户等级 Lv${level}"`);
      expect(html).toContain(`data-comment-level="${level}"`);
      const match = html.match(/text-comment-level-(\d)/);
      expect(match?.[1]).toBe(String(level));
      classes.add(match![1]);
    }
    expect(classes.size).toBe(6);
  });

  test("未知正整数沿用中性色，不冒充最高等级", () => {
    const html = render(12);
    expect(html).toContain("Lv12");
    expect(html).toContain("text-comment-level-1");
  });

  test("无效或非正整数不渲染", () => {
    for (const level of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(render(level)).toBe("");
    }
  });
});
