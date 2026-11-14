import { describe, expect, test } from "bun:test";
import {
  articleCoverForDisplay,
  articleHeadingLevel,
  articleSummaryForDisplay,
  safeHttpLink,
} from "../src/features/acfun/acfunArticleContent";
import type { AcfunArticleBlock } from "../src/features/acfun/acfunTypes";

describe("AcFun 文章内容语义", () => {
  test("只允许 HTTP 和 HTTPS 外链", () => {
    expect(safeHttpLink(" https://example.com/a ")).toBe("https://example.com/a");
    expect(safeHttpLink("http://example.com/a")).toBe("http://example.com/a");
    expect(safeHttpLink("javascript:alert(1)")).toBeNull();
    expect(safeHttpLink("data:text/html,test")).toBeNull();
    expect(safeHttpLink("not a url")).toBeNull();
  });

  test("正文标题保留层级并落在 h2-h6", () => {
    expect([1, 2, 3, 4, 5, 6].map(articleHeadingLevel)).toEqual([2, 3, 4, 5, 6, 6]);
    expect(articleHeadingLevel(0)).toBe(2);
    expect(articleHeadingLevel(Number.NaN)).toBe(2);
  });

  test("只在封面与正文图片为同一资源时省略封面", () => {
    const blocks = [
      { type: "image", url: "https://imgs.example.com/cover.jpg" },
    ] satisfies AcfunArticleBlock[];
    expect(articleCoverForDisplay("http://imgs.example.com/cover.jpg#hero", blocks)).toBeNull();
    expect(articleCoverForDisplay("https://imgs.example.com/other.jpg", blocks)).toBe(
      "https://imgs.example.com/other.jpg",
    );
    expect(articleCoverForDisplay("javascript:alert(1)", blocks)).toBeNull();
  });

  test("只在摘要重复标题或正文首段时省略摘要", () => {
    const blocks = [
      {
        type: "paragraph",
        text: "第一段  正文 链接",
        inlines: [
          { type: "text", text: "第一段  正文 ", bold: true },
          {
            type: "link",
            text: "链接",
            url: "https://example.com/read",
            italic: true,
          },
        ],
      },
    ] satisfies AcfunArticleBlock[];
    expect(articleSummaryForDisplay("标题", "标题", blocks)).toBeNull();
    expect(articleSummaryForDisplay("文章标题", "第一段 正文 链接", blocks)).toBeNull();
    expect(articleSummaryForDisplay("文章标题", "独立摘要", blocks)).toBe("独立摘要");
    expect(articleSummaryForDisplay("文章标题", "   ", blocks)).toBeNull();
  });
});
