import { describe, expect, test } from "bun:test";
import {
  BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY,
  danmakuImageRequestUrl,
  floatingRichSpans,
  hasValidDanmakuContentSpans,
  normalizeDanmakuImageUrl,
  richDanmakuContent,
  withDanmakuContentSuffix,
} from "../src/features/room/danmaku/content";
import { buildProxyTarget, shouldProxyHost } from "../src/shared/api/imageProxy";
import type { DanmakuEvent } from "../src/shared/types/live";

const EMOTE_URL = "//i0.hdslb.com/bfs/emote/question.png";
const NORMALIZED_EMOTE_URL = "https://i0.hdslb.com/bfs/emote/question.png";

function spanEvent(overrides: Partial<DanmakuEvent> = {}): DanmakuEvent {
  return {
    kind: "chat",
    user: "观众",
    content: "打卡[dog]",
    color: null,
    ts: 1,
    spans: [
      { type: "text", text: "打卡" },
      { type: "image", image_url: EMOTE_URL },
    ],
    ...overrides,
  } as DanmakuEvent;
}

describe("rich danmaku content", () => {
  test("omits the desktop app Referer for Bilibili CDN emotes", () => {
    expect(BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY).toBe("no-referrer");
  });

  test("normalizes trusted Bilibili CDN URLs to HTTPS", () => {
    expect(normalizeDanmakuImageUrl("//i0.hdslb.com/bfs/emote/question.png")).toBe(
      "https://i0.hdslb.com/bfs/emote/question.png",
    );
    expect(normalizeDanmakuImageUrl("http://i0.hdslb.com/bfs/emote/legacy.png")).toBe(
      "https://i0.hdslb.com/bfs/emote/legacy.png",
    );
    // Bilibili 直播的一次性表情使用同一个 CDN 的 `/bfs/live/` 路径而非 `/bfs/emote/`。
    expect(
      normalizeDanmakuImageUrl(
        "http://i0.hdslb.com/bfs/live/b3495aaa935b045bfc2e1d52738ea7b124e0d552.png",
      ),
    ).toBe("https://i0.hdslb.com/bfs/live/b3495aaa935b045bfc2e1d52738ea7b124e0d552.png");
  });

  test("accepts Twitch emote CDN URLs", () => {
    const emote = "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0";
    expect(normalizeDanmakuImageUrl(emote)).toBe(emote);
    expect(shouldProxyHost("static-cdn.jtvnw.net")).toBe(true);
  });

  test("accepts 7TV emote CDN URLs", () => {
    const emote = "https://cdn.7tv.app/emote/01G3WEGZN0000ET2J0MQP5YJ0G/2x.webp";
    expect(normalizeDanmakuImageUrl(emote)).toBe(emote);
    expect(shouldProxyHost("cdn.7tv.app")).toBe(true);
    // 后缀拼接不能把仿冒域放进来。
    expect(normalizeDanmakuImageUrl("https://cdn.7tv.app.evil.invalid/e.webp")).toBeNull();
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

  test("appends an aggregation suffix as its own fragment after a trailing emote", () => {
    // 直播层与录制 canvas 都依赖这一点：计数绝不能折叠进图片片段。
    expect(withDanmakuContentSuffix([{ type: "image", image_url: EMOTE_URL }], " ×3")).toEqual([
      { type: "image", image_url: EMOTE_URL },
      { type: "text", text: " ×3" },
    ]);
  });
});

describe("floating rich spans", () => {
  test("normalizes protocol emotes for both renderers", () => {
    expect(floatingRichSpans(spanEvent())).toEqual([
      { type: "text", text: "打卡" },
      { type: "image", image_url: NORMALIZED_EMOTE_URL },
    ]);
  });

  test("restores the SC marker without disturbing image order", () => {
    expect(floatingRichSpans(spanEvent({ kind: "super_chat" }))).toEqual([
      { type: "text", text: "【SC】" },
      { type: "text", text: "打卡" },
      { type: "image", image_url: NORMALIZED_EMOTE_URL },
    ]);
  });

  test("does not duplicate an SC marker the payload already carries", () => {
    const spans = floatingRichSpans(
      spanEvent({
        kind: "super_chat",
        spans: [
          { type: "text", text: "【SC】谢谢" },
          { type: "image", image_url: EMOTE_URL },
        ],
      }),
    );

    expect(spans).toEqual([
      { type: "text", text: "【SC】谢谢" },
      { type: "image", image_url: NORMALIZED_EMOTE_URL },
    ]);
  });

  test("stays undefined for a text-only payload so the plain path is used", () => {
    expect(
      floatingRichSpans(spanEvent({ spans: [{ type: "text", text: "纯文本" }] })),
    ).toBeUndefined();
    expect(floatingRichSpans(spanEvent({ spans: null }))).toBeUndefined();
  });
});

describe("danmaku emote request urls", () => {
  test("falls back to the direct CDN url when the image proxy is not running", () => {
    // Tauri 之外代理永远不会就绪，表情必须仍能直接加载而不丢失图片。
    expect(danmakuImageRequestUrl(NORMALIZED_EMOTE_URL)).toBe(NORMALIZED_EMOTE_URL);
  });

  test("keeps the proxy target on the cached path so a repeat emote is a local read", () => {
    const base = "http://127.0.0.1:51234";
    expect(buildProxyTarget(base, NORMALIZED_EMOTE_URL)).toBe(
      `${base}/img?url=${encodeURIComponent(NORMALIZED_EMOTE_URL)}`,
    );
    expect(buildProxyTarget(base, NORMALIZED_EMOTE_URL)).not.toContain("nocache=1");
  });

  test("proxies every host the span validator trusts", () => {
    for (const host of ["i0.hdslb.com", "bilibili.com", "i0.biliimg.com"]) {
      expect(shouldProxyHost(host)).toBe(true);
    }
    expect(shouldProxyHost("example.invalid")).toBe(false);
    expect(shouldProxyHost("evil-hdslb.com")).toBe(false);
  });
});
