import { afterEach, describe, expect, test } from "bun:test";
import {
  DANMAKU_IMAGE_HORIZONTAL_GAP,
  DANMAKU_IMAGE_SCALE,
} from "../src/features/room/danmaku/content";
import { parseRecordedDanmakuSidecar } from "../src/features/recording/recordedDanmaku";
import {
  createRecordedDanmakuImageCache,
  recordedDanmakuSegments,
  recordedDanmakuSegmentsWidth,
  recordedDanmakuSpans,
} from "../src/features/recording/recordedDanmakuSpans";
import type { DanmakuContentSpan, DanmakuEvent } from "../src/shared/types/live";

const EMOTE_URL = "//i0.hdslb.com/bfs/emote/question.png";
const NORMALIZED_EMOTE_URL = "https://i0.hdslb.com/bfs/emote/question.png";
const FONT_SIZE = 24;

/** canvas 度量的替身：每个码点固定步进。 */
function measureText(text: string): number {
  return [...text].length * FONT_SIZE;
}

/**
 * 按回放的方式、经由伴生解析器构建条目，
 * 使测试经历真实负载所经过的同一条校验链路。
 */
function sidecarEntries(events: readonly Partial<DanmakuEvent>[]) {
  return parseRecordedDanmakuSidecar(
    JSON.stringify({
      offset_ms: 1_000,
      events: events.map((event) => ({
        kind: "chat",
        user: "观众",
        content: "打卡[dog]",
        color: null,
        ts: 1,
        ...event,
      })),
    }),
  );
}

describe("recorded danmaku spans", () => {
  test("keeps image emotes from the sidecar payload", () => {
    const [entry] = sidecarEntries([
      {
        spans: [
          { type: "text", text: "打卡" },
          { type: "image", image_url: EMOTE_URL },
        ],
      },
    ]);

    expect(entry).toBeDefined();
    expect(recordedDanmakuSpans(entry!, 1)).toEqual([
      { type: "text", text: "打卡" },
      { type: "image", image_url: NORMALIZED_EMOTE_URL },
    ]);
  });

  test("returns null for a text-only entry so the plain text path is used", () => {
    const [plain] = sidecarEntries([{ content: "普通弹幕" }]);
    const [textSpans] = sidecarEntries([
      { content: "普通弹幕", spans: [{ type: "text", text: "普通弹幕" }] },
    ]);

    expect(recordedDanmakuSpans(plain!, 1)).toBeNull();
    expect(recordedDanmakuSpans(textSpans!, 1)).toBeNull();
  });

  test("puts the repeat counter after the last fragment", () => {
    const [entry] = sidecarEntries([{ spans: [{ type: "image", image_url: EMOTE_URL }] }]);

    // 计数为 1 是未合并的情况，不得添加后缀。
    expect(recordedDanmakuSpans(entry!, 1)).toEqual([
      { type: "image", image_url: NORMALIZED_EMOTE_URL },
    ]);
    expect(recordedDanmakuSpans(entry!, 4)).toEqual([
      { type: "image", image_url: NORMALIZED_EMOTE_URL },
      { type: "text", text: " ×4" },
    ]);
  });

  test("restores the SC marker for a super chat carrying emotes", () => {
    const [entry] = sidecarEntries([
      {
        kind: "super_chat",
        spans: [
          { type: "text", text: "谢谢" },
          { type: "image", image_url: EMOTE_URL },
        ],
      },
    ]);

    expect(recordedDanmakuSpans(entry!, 1)).toEqual([
      { type: "text", text: "【SC】" },
      { type: "text", text: "谢谢" },
      { type: "image", image_url: NORMALIZED_EMOTE_URL },
    ]);
  });
});

describe("recorded danmaku segments", () => {
  const spans: readonly DanmakuContentSpan[] = [
    { type: "text", text: "打卡" },
    { type: "image", image_url: NORMALIZED_EMOTE_URL },
    { type: "text", text: " ×2" },
  ];

  test("measures an emote as a square box at the shared image scale", () => {
    const segments = recordedDanmakuSegments(spans, FONT_SIZE, measureText);

    expect(segments).toEqual([
      { type: "text", text: "打卡", width: 2 * FONT_SIZE },
      {
        type: "image",
        url: NORMALIZED_EMOTE_URL,
        size: FONT_SIZE * DANMAKU_IMAGE_SCALE,
        width: FONT_SIZE * DANMAKU_IMAGE_SCALE + DANMAKU_IMAGE_HORIZONTAL_GAP,
      },
      { type: "text", text: " ×2", width: 3 * FONT_SIZE },
    ]);
  });

  test("reserves more width than the token text it replaces", () => {
    const segments = recordedDanmakuSegments(spans, FONT_SIZE, measureText);
    const width = recordedDanmakuSegmentsWidth(segments);

    // 车道布局按表情绘制的盒子计费，而不是 token 文本碰巧有多宽 ——
    // 这正是防止富文本弹幕获批的车道槽位窄于其实际绘制宽度的机制。
    expect(width).toBe(
      5 * FONT_SIZE + FONT_SIZE * DANMAKU_IMAGE_SCALE + DANMAKU_IMAGE_HORIZONTAL_GAP,
    );
    expect(width).toBeGreaterThan(measureText("打卡 ×2"));
  });

  test("skips empty text fragments", () => {
    const segments = recordedDanmakuSegments(
      [
        { type: "text", text: "" },
        { type: "image", image_url: NORMALIZED_EMOTE_URL },
      ],
      FONT_SIZE,
      measureText,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]!.type).toBe("image");
  });
});

type StubImage = {
  src: string;
  referrerPolicy: string;
  decoding: string;
  listeners: Map<string, () => void>;
  addEventListener: (type: string, listener: () => void, options?: unknown) => void;
};

const originalImage = (globalThis as { Image?: unknown }).Image;
const created: StubImage[] = [];

function installImageStub(): void {
  created.length = 0;
  (globalThis as { Image?: unknown }).Image = function StubImageConstructor(this: StubImage) {
    const stub = this;
    stub.src = "";
    stub.referrerPolicy = "";
    stub.decoding = "";
    stub.listeners = new Map();
    stub.addEventListener = (type, listener) => {
      stub.listeners.set(type, listener);
    };
    created.push(stub);
  } as unknown as typeof Image;
}

afterEach(() => {
  if (originalImage === undefined) delete (globalThis as { Image?: unknown }).Image;
  else (globalThis as { Image?: unknown }).Image = originalImage;
});

describe("recorded danmaku image cache", () => {
  test("requests each URL once and reports the decoded image after load", () => {
    installImageStub();
    let settled = 0;
    const cache = createRecordedDanmakuImageCache(() => {
      settled += 1;
    });

    // 第一帧只是发起请求；还画不出任何东西。
    expect(cache.resolve(NORMALIZED_EMOTE_URL)).toBeNull();
    expect(cache.resolve(NORMALIZED_EMOTE_URL)).toBeNull();
    expect(created).toHaveLength(1);
    // 策略必须在 `src` 之前设置，否则请求携带 webview 的 `tauri://…` Referer、
    // Bilibili CDN 回以 403。
    expect(created[0]!.referrerPolicy).toBe("no-referrer");
    expect(created[0]!.src).toBe(NORMALIZED_EMOTE_URL);

    created[0]!.listeners.get("load")?.();

    expect(settled).toBe(1);
    expect(cache.resolve(NORMALIZED_EMOTE_URL)).toBe(created[0] as unknown as HTMLImageElement);
    expect(cache.hasFailed(NORMALIZED_EMOTE_URL)).toBe(false);
    expect(created).toHaveLength(1);
  });

  test("marks a failed request so the painter can substitute text", () => {
    installImageStub();
    const cache = createRecordedDanmakuImageCache(() => undefined);

    cache.resolve(NORMALIZED_EMOTE_URL);
    created[0]!.listeners.get("error")?.();

    expect(cache.hasFailed(NORMALIZED_EMOTE_URL)).toBe(true);
    expect(cache.resolve(NORMALIZED_EMOTE_URL)).toBeNull();
    // 失败的 URL 会被记住，而不是每帧重试。
    expect(created).toHaveLength(1);
  });

  test("stops loading and reporting after dispose", () => {
    installImageStub();
    let settled = 0;
    const cache = createRecordedDanmakuImageCache(() => {
      settled += 1;
    });

    cache.resolve(NORMALIZED_EMOTE_URL);
    cache.dispose();
    created[0]!.listeners.get("load")?.();

    expect(settled).toBe(0);
    expect(cache.resolve(NORMALIZED_EMOTE_URL)).toBeNull();
    expect(created).toHaveLength(1);
  });
});
