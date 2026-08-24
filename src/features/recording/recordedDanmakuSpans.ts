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
 * Image emotes for the recorded-playback canvas.
 *
 * The live floating layer paints spans as DOM `<img>` children, which a canvas
 * cannot reuse. This module turns the same validated span list into measured
 * segments so lane layout reserves the real width, and keeps the decoded images
 * around so a scrolling bullet does not re-request an emote every frame.
 */

/** Emote images kept decoded at once; recordings reuse very few distinct URLs. */
const MAX_RECORDED_DANMAKU_IMAGES = 256;

export type RecordedDanmakuSegment =
  | { readonly type: "text"; readonly text: string; readonly width: number }
  | {
      readonly type: "image";
      readonly url: string;
      /** Painted edge length, matching the DOM layer's `1.35em` box. */
      readonly size: number;
      readonly width: number;
    };

/**
 * Repeat-counter tail matching `aggregatedDanmakuText`, so the text and rich
 * paths reserve the same width for the same count.
 */
function aggregationSuffix(count: number): string {
  const safeCount = Math.floor(count);
  return safeCount > 1 ? ` ×${safeCount}` : "";
}

/**
 * Rich spans for one recorded bullet, or null when it is plain text. `count` is
 * the number of folded messages already shown, so the counter lands after the
 * last fragment instead of disturbing image order.
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
 * Split spans into paintable segments. `measureText` must use the same font the
 * painter will apply, or reserved and painted widths drift apart.
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
  /** Decoded image, or null while the request is in flight or after it failed. */
  resolve: (url: string) => HTMLImageElement | null;
  /** True once the request failed, so the painter can substitute text. */
  hasFailed: (url: string) => boolean;
  dispose: () => void;
};

type CacheEntry = { image: HTMLImageElement; status: "loading" | "ready" | "failed" };

/**
 * Loads emote images once per URL and reports settled requests through
 * `onSettled`, which lets a paused overlay repaint when an emote arrives.
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
      // Insertion order doubles as an eviction queue: a long recording with many
      // distinct emotes cannot grow the cache without bound.
      while (entries.size >= MAX_RECORDED_DANMAKU_IMAGES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(url, entry);
      image.addEventListener("load", () => settle(entry, "ready"), { once: true });
      image.addEventListener("error", () => {
        // A proxy that is down must not cost the emote its picture: retry once
        // against the CDN before the bullet falls back to its text marker.
        if (image.src !== url) {
          image.src = url;
          return;
        }
        settle(entry, "failed");
      });
      // Bilibili's CDN rejects the webview's `tauri://…` Referer, and the policy
      // only applies to a request that has not started yet.
      image.referrerPolicy = BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY;
      image.decoding = "async";
      // Prefer the localhost proxy so a repeat playback reads the emote from the
      // disk cache instead of the CDN. The policy above still covers the direct
      // fallback used before the proxy has started.
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
