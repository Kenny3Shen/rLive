import { describe, expect, test } from "bun:test";
import {
  BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY,
  floatingRichSpans,
  hasValidDanmakuContentSpans,
  normalizeDanmakuImageUrl,
  richDanmakuContent,
  withDanmakuContentSuffix,
} from "../src/features/room/danmaku/content";
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
    // Bilibili live's one-off emotes use this same CDN with `/bfs/live/`
    // paths rather than `/bfs/emote/`.
    expect(
      normalizeDanmakuImageUrl(
        "http://i0.hdslb.com/bfs/live/b3495aaa935b045bfc2e1d52738ea7b124e0d552.png",
      ),
    ).toBe("https://i0.hdslb.com/bfs/live/b3495aaa935b045bfc2e1d52738ea7b124e0d552.png");
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
    // The live layer and the recorded canvas both rely on this: a counter must
    // never be folded into an image fragment.
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
