import type { DanmakuContentSpan, DanmakuEvent } from "@/shared/types/live";

/** Simple Live renders protocol image emotes at 1.35× the chat font size. */
export const DANMAKU_IMAGE_SCALE = 1.35;
/** Total inline breathing room around one image emote, in CSS pixels. */
export const DANMAKU_IMAGE_HORIZONTAL_GAP = 2;
/** Shown in place of an emote whose URL is rejected or whose request fails. */
export const DANMAKU_IMAGE_FALLBACK_TEXT = "[表情]";
/**
 * Bilibili's CDN rejects the desktop webview's `tauri://…` Referer with 403.
 * Explicitly omitting it keeps DOM image requests compatible
 * with the same CDN URLs that normal Bilibili pages use.
 */
export const BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY = "no-referrer" as const;

const MAX_DANMAKU_CONTENT_SPANS = 32;
const MAX_DANMAKU_IMAGE_URL_LENGTH = 2_048;

function isTrustedBilibiliImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "hdslb.com" ||
    host.endsWith(".hdslb.com") ||
    host === "bilibili.com" ||
    host.endsWith(".bilibili.com") ||
    host === "biliimg.com" ||
    host.endsWith(".biliimg.com")
  );
}

/**
 * Bilibili's danmaku payload may use a protocol-relative CDN URL. Convert it
 * to HTTPS and keep only the platform's image CDNs before it reaches an img
 * tag.
 */
export function normalizeDanmakuImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = value.trim();
  if (!source || source.length > MAX_DANMAKU_IMAGE_URL_LENGTH) return null;
  const normalized = source.startsWith("//") ? `https:${source}` : source;
  try {
    const url = new URL(normalized);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !isTrustedBilibiliImageHost(url.hostname)
    ) {
      return null;
    }
    // The native decoder performs the same upgrade. Retaining it here makes
    // the browser-side guard resilient to legacy payloads and avoids a mixed
    // content request if a future backend event reaches the WebView directly.
    url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}

export function isDanmakuContentSpan(value: unknown): value is DanmakuContentSpan {
  if (!value || typeof value !== "object") return false;
  const span = value as { type?: unknown; text?: unknown; image_url?: unknown };
  if (span.type === "text") return typeof span.text === "string";
  return span.type === "image" && normalizeDanmakuImageUrl(span.image_url) !== null;
}

export function hasValidDanmakuContentSpans(value: unknown): value is DanmakuContentSpan[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_DANMAKU_CONTENT_SPANS &&
    value.every(isDanmakuContentSpan)
  );
}

/**
 * Returns rich fragments only when there is an actual image to substitute.
 * Text-only arrays use the regular allocation-free text path.
 */
export function richDanmakuContent(spans: unknown): readonly DanmakuContentSpan[] | null {
  if (!hasValidDanmakuContentSpans(spans) || !spans.some((span) => span.type === "image")) {
    return null;
  }

  const normalized: DanmakuContentSpan[] = [];
  for (const span of spans) {
    if (span.type === "text") {
      if (span.text) normalized.push(span);
      continue;
    }
    const imageUrl = normalizeDanmakuImageUrl(span.image_url);
    if (imageUrl) normalized.push({ type: "image", image_url: imageUrl });
  }
  return normalized.some((span) => span.type === "image") ? normalized : null;
}

/**
 * Rich fragments for a floating bullet, with the `【SC】` marker restored when
 * the payload only carries the raw message. Both the live DOM renderer and the
 * recorded-playback canvas read spans through here so the two paths cannot
 * drift apart.
 */
export function floatingRichSpans(event: DanmakuEvent): readonly DanmakuContentSpan[] | undefined {
  const spans = richDanmakuContent(event.spans);
  if (!spans) return undefined;
  const firstSpan = spans[0];
  const hasSuperChatMarker =
    firstSpan?.type === "text" && firstSpan.text.trimStart().startsWith("【SC】");
  if (event.kind === "super_chat" && !hasSuperChatMarker) {
    return [{ type: "text", text: "【SC】" }, ...spans];
  }
  return spans;
}

/** Add an aggregation suffix after the last rich fragment without changing image order. */
export function withDanmakuContentSuffix(
  spans: readonly DanmakuContentSpan[],
  suffix: string,
): DanmakuContentSpan[] {
  if (!suffix) return [...spans];
  const next = [...spans];
  const last = next.at(-1);
  if (last?.type === "text") {
    next[next.length - 1] = { type: "text", text: `${last.text}${suffix}` };
  } else {
    next.push({ type: "text", text: suffix });
  }
  return next;
}
