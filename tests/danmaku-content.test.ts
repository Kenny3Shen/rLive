import { describe, expect, test } from "bun:test";
import {
  hasValidDanmakuContentSpans,
  normalizeDanmakuImageUrl,
  richDanmakuContent,
  withDanmakuContentSuffix,
} from "../src/features/room/danmaku/content";

describe("rich danmaku content", () => {
  test("normalizes trusted Bilibili CDN URLs to HTTPS", () => {
    expect(normalizeDanmakuImageUrl("//i0.hdslb.com/bfs/emote/question.png")).toBe(
      "https://i0.hdslb.com/bfs/emote/question.png",
    );
    expect(normalizeDanmakuImageUrl("http://i0.hdslb.com/bfs/emote/legacy.png")).toBe(
      "https://i0.hdslb.com/bfs/emote/legacy.png",
    );
  });

  test("rejects image URLs outside Bilibili CDN hosts or with credentials", () => {
    expect(normalizeDanmakuImageUrl("https://example.invalid/emote.png")).toBeNull();
    expect(normalizeDanmakuImageUrl("https://user:pass@i0.hdslb.com/emote.png")).toBeNull();
    expect(normalizeDanmakuImageUrl("javascript:alert(1)")).toBeNull();
  });

  test("keeps text and image fragments in protocol order", () => {
    const spans = [
      { type: "text" as const, text: "前缀" },
      {
        type: "image" as const,
        image_url: "//i0.hdslb.com/bfs/emote/question.png",
      },
      { type: "text" as const, text: "后缀" },
    ];

    expect(hasValidDanmakuContentSpans(spans)).toBe(true);
    expect(richDanmakuContent(spans)).toEqual([
      { type: "text", text: "前缀" },
      {
        type: "image",
        image_url: "https://i0.hdslb.com/bfs/emote/question.png",
      },
      { type: "text", text: "后缀" },
    ]);
    expect(withDanmakuContentSuffix(spans, " ×2")).toEqual([
      { type: "text", text: "前缀" },
      {
        type: "image",
        image_url: "//i0.hdslb.com/bfs/emote/question.png",
      },
      { type: "text", text: "后缀 ×2" },
    ]);
  });
});
