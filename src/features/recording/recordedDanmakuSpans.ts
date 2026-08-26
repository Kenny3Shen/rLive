import {
  BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY,
  DANMAKU_IMAGE_HORIZONTAL_GAP,
  DANMAKU_IMAGE_SCALE,
  danmakuImageRequestUrl,
  floatingRichSpans,
  withDanmakuContentSuffix,
} from "@/features/room/danmaku/content";
import type { DanmakuContentSpan } from "@/shared/types/live";
import type { RecordedDanmakuEntry } from "./recordedDanmaku";

/**
 * 供录制回放 canvas 使用的图片表情。
 *
 * 直播悬浮层把片段画成 DOM `<img>` 子元素，canvas 无法复用。本模块把同一份
 * 校验过的片段列表转换为测量后的分段，使车道布局预留真实宽度，
 * 并把解码后的图片保留下来，避免滚动中的弹幕每帧都重新请求表情。
 */

/** 同时保持解码状态的表情图片数量；录制只会用到极少数不同的 URL。 */
const MAX_RECORDED_DANMAKU_IMAGES = 256;

export type RecordedDanmakuSegment =
  | { readonly type: "text"; readonly text: string; readonly width: number }
  | {
      readonly type: "image";
      readonly url: string;
      /** 绘制的边长，对应 DOM 层的 `1.35em` 盒子。 */
      readonly size: number;
      readonly width: number;
    };

/**
 * 与 `aggregatedDanmakuText` 一致的重复计数尾巴，
 * 使文本路径与富文本路径为相同计数预留相同宽度。
 */
function aggregationSuffix(count: number): string {
  const safeCount = Math.floor(count);
  return safeCount > 1 ? ` ×${safeCount}` : "";
}

/**
 * 单条录制弹幕的富文本片段；纯文本时为 null。`count` 是已展示的折叠消息数，
 * 因此计数落在最后一个片段之后，不打乱图片顺序。
 */
export function recordedDanmakuSpans(
  entry: RecordedDanmakuEntry,
  count: number,
): readonly DanmakuContentSpan[] | null {
  const spans = floatingRichSpans(entry.event);
  if (!spans) return null;
  return withDanmakuContentSuffix(spans, aggregationSuffix(count));
}

/**
 * 把片段拆分为可绘制的分段。`measureText` 必须使用与绘制器相同的字体，
 * 否则预留宽度与实际绘制宽度会产生漂移。
 */
export function recordedDanmakuSegments(
  spans: readonly DanmakuContentSpan[],
  fontSize: number,
  measureText: (text: string) => number,
): RecordedDanmakuSegment[] {
  const size = Math.max(1, fontSize * DANMAKU_IMAGE_SCALE);
  const segments: RecordedDanmakuSegment[] = [];
  for (const span of spans) {
    if (span.type === "text") {
      if (!span.text) continue;
      segments.push({ type: "text", text: span.text, width: measureText(span.text) });
      continue;
    }
    segments.push({
      type: "image",
      url: span.image_url,
      size,
      width: size + DANMAKU_IMAGE_HORIZONTAL_GAP,
    });
  }
  return segments;
}

export function recordedDanmakuSegmentsWidth(segments: readonly RecordedDanmakuSegment[]): number {
  let total = 0;
  for (const segment of segments) total += segment.width;
  return total;
}

export type RecordedDanmakuImageCache = {
  /** 已解码的图片；请求在途或失败时为 null。 */
  resolve: (url: string) => HTMLImageElement | null;
  /** 请求失败后为 true，绘制器以此改用文本替代。 */
  hasFailed: (url: string) => boolean;
  dispose: () => void;
};

type CacheEntry = { image: HTMLImageElement; status: "loading" | "ready" | "failed" };

/**
 * 每个 URL 只加载一次表情图片，并通过 `onSettled` 上报已完成的请求，
 * 使暂停中的叠加层在表情到达时得以重绘。
 */
export function createRecordedDanmakuImageCache(onSettled: () => void): RecordedDanmakuImageCache {
  const entries = new Map<string, CacheEntry>();
  let disposed = false;

  const settle = (entry: CacheEntry, status: "ready" | "failed") => {
    entry.status = status;
    if (!disposed) onSettled();
  };

  return {
    resolve(url) {
      const existing = entries.get(url);
      if (existing) return existing.status === "ready" ? existing.image : null;
      if (disposed) return null;

      const image = new Image();
      const entry: CacheEntry = { image, status: "loading" };
      // 插入顺序兼作淘汰队列：包含大量不同表情的长录像
      // 不能让缓存无限增长。
      while (entries.size >= MAX_RECORDED_DANMAKU_IMAGES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(url, entry);
      image.addEventListener("load", () => settle(entry, "ready"), { once: true });
      image.addEventListener("error", () => {
        // 代理宕机不应让表情失去图片：在弹幕退回文本标记前，
        // 先对 CDN 重试一次。
        if (image.src !== url) {
          image.src = url;
          return;
        }
        settle(entry, "failed");
      });
      // Bilibili 的 CDN 会拒绝 webview 的 `tauri://…` Referer，
      // 而且策略只对尚未发出的请求生效。
      image.referrerPolicy = BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY;
      image.decoding = "async";
      // 优先使用本机代理，使重复回放从磁盘缓存读取表情而不是 CDN。
      // 上面的策略仍然覆盖代理启动前的直连兜底。
      image.src = danmakuImageRequestUrl(url);
      return null;
    },
    hasFailed(url) {
      return entries.get(url)?.status === "failed";
    },
    dispose() {
      disposed = true;
      entries.clear();
    },
  };
}
