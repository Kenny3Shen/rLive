import type { DanmuJsComment, DanmuJsStyle } from "danmu.js";
import type { DanmakuContentSpan, DanmakuEvent } from "@/shared/types/live";
import {
  BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY,
  DANMAKU_IMAGE_SCALE,
  normalizeDanmakuImageUrl,
  richDanmakuContent,
} from "./content";
import { floatingDanmakuText } from "./filter";
import { superChatDurationMs } from "../superChat";

export const DANMU_JS_MAX_ACTIVE_COMMENTS = 80;
export const DANMU_JS_MAX_PENDING_COMMENTS = 80;
export const DANMU_JS_MAX_SUPER_CHATS = 3;
export const DANMU_JS_PENDING_MAX_AGE_MS = 5_000;
export const DANMU_JS_DEFAULT_DURATION_MS = 15_000;
export const DANMU_JS_DEFAULT_MOVE_V = 100;
export const DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT = 9_999;

export type DanmuJsPendingEvent = {
  event: DanmakuEvent;
  queuedAt: number;
};

/** Add a batch to the bounded zero-size queue, retaining the newest events. */
export function enqueueDanmuJsPending(
  queue: DanmuJsPendingEvent[],
  events: readonly DanmakuEvent[],
  queuedAt = Date.now(),
  capacity = DANMU_JS_MAX_PENDING_COMMENTS,
): void {
  for (const event of events) queue.push({ event, queuedAt });
  const safeCapacity = Number.isFinite(capacity)
    ? Math.max(0, Math.floor(capacity))
    : DANMU_JS_MAX_PENDING_COMMENTS;
  const overflow = queue.length - safeCapacity;
  if (overflow > 0) queue.splice(0, overflow);
}

/** Remove and return only pending events that have not exceeded their age. */
export function flushDanmuJsPending(
  queue: DanmuJsPendingEvent[],
  now = Date.now(),
  maxAge = DANMU_JS_PENDING_MAX_AGE_MS,
): DanmakuEvent[] {
  const safeMaxAge = Math.max(0, Number.isFinite(maxAge) ? maxAge : DANMU_JS_PENDING_MAX_AGE_MS);
  return queue
    .splice(0)
    .filter((pending) => now - pending.queuedAt <= safeMaxAge)
    .map((pending) => pending.event);
}

export type DanmuJsBulletMeta = {
  id: string;
  event: DanmakuEvent;
  baseText: string;
  spans?: readonly DanmakuContentSpan[];
  aggregationKey?: string;
  aggregationCount: number;
  element?: HTMLElement;
  contentElement?: HTMLElement;
  countElement?: HTMLElement;
  countSlotElement?: HTMLElement;
};

export type DanmuJsMappingOptions = {
  id: string;
  fontSize: number;
  fontWeight: number;
  opacity: number;
  aggregationKey?: string;
  aggregationCount?: number;
};

export type DanmuJsRenderLayer = "scroll" | "bottom";

export function clampDanmuFontSize(value: number, fallback = 18): number {
  const next = Number.isFinite(value) ? value : fallback;
  return Math.max(12, Math.min(48, Math.round(next)));
}

export function clampDanmuFontWeight(value: number, fallback = 600): number {
  const next = Number.isFinite(value) ? value : fallback;
  if (next < 450) return 400;
  if (next < 550) return 500;
  if (next < 650) return 600;
  return 700;
}

export function clampDanmuOpacity(value: number, fallback = 1): number {
  const next = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, next));
}

export function clampDanmuArea(value: number, fallback = 0.25): number {
  const safeFallback = Number.isFinite(fallback) ? fallback : 0.25;
  const next = Number.isFinite(value) ? value : safeFallback;
  return Math.max(0.1, Math.min(1, next));
}

/** Keep danmu.js' virtual channel height aligned with the rendered line box. */
export function danmuLaneHeight(fontSize: number): number {
  return Math.max(16, Math.round(clampDanmuFontSize(fontSize) * 1.4));
}

/** Convert the requested px/s into danmu.js' multiplier for the 100 px/s base moveV. */
export function danmuMoveVPlayRate(moveV: number): number {
  const safeMoveV = Number.isFinite(moveV) && moveV > 0 ? moveV : DANMU_JS_DEFAULT_MOVE_V;
  return safeMoveV / DANMU_JS_DEFAULT_MOVE_V;
}

/** Use danmu.js' native proportional area without overriding it with `lines`. */
export function danmuAreaConfig(area: number): { start: number; end: number } {
  return { start: 0, end: clampDanmuArea(area) };
}

/** Keep fixed comments independent from the configured scrolling area. */
export function danmuRenderLayer(comment: Pick<DanmuJsComment, "mode">): DanmuJsRenderLayer {
  return comment.mode === "bottom" ? "bottom" : "scroll";
}

export function danmuLayerAreaConfig(
  layer: DanmuJsRenderLayer,
  scrollArea: number,
): { start: number; end: number } {
  return layer === "bottom" ? { start: 0, end: 1 } : danmuAreaConfig(scrollArea);
}

/** Accept only compact color values before native payloads reach inline CSS. */
export function safeDanmuColor(value: unknown, fallback = "#ffffff"): string {
  if (typeof value !== "string") return fallback;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(?:rgb|hsl)a?\(\s*[\d.%\s,()+-]+\)$/i.test(color)) return color;
  if (/^[a-z]{1,24}$/i.test(color)) return color.toLowerCase();
  return fallback;
}

function superChatAmountColor(event: DanmakuEvent): string {
  return safeDanmuColor(
    event.super_chat?.background_bottom_color,
    safeDanmuColor(event.super_chat?.background_color, "#2A60B2"),
  );
}

function aggregateSuffix(count: number): string {
  const safeCount = Math.max(1, Math.floor(count));
  if (safeCount <= 1) return "";
  return safeCount > DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT
    ? ` ×${DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT}+`
    : ` ×${safeCount}`;
}

function floatingRichSpans(event: DanmakuEvent): readonly DanmakuContentSpan[] | undefined {
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

export function danmuStyleForEvent(
  event: DanmakuEvent,
  options: Pick<DanmuJsMappingOptions, "fontSize" | "fontWeight" | "opacity">,
): DanmuJsStyle {
  const isSuperChat = event.kind === "super_chat";
  const opacity = clampDanmuOpacity(options.opacity);
  const style: DanmuJsStyle = {
    boxSizing: "border-box",
    color: isSuperChat ? superChatAmountColor(event) : safeDanmuColor(event.color),
    opacity: String(opacity),
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "nowrap",
    whiteSpace: "nowrap",
    width: "max-content",
    maxWidth: "none",
    fontSize: `${clampDanmuFontSize(options.fontSize)}px`,
    fontWeight: clampDanmuFontWeight(options.fontWeight),
    lineHeight: "1.35",
    textShadow: "0 1px 2px rgba(0,0,0,.92), 0 0 3px rgba(0,0,0,.72)",
    pointerEvents: isSuperChat ? "auto" : "none",
  };

  return style;
}

/** Map one validated live event without importing its Unix timestamp into the media timeline. */
export function danmuCommentFromEvent(
  event: DanmakuEvent,
  options: DanmuJsMappingOptions,
): (DanmuJsComment & { __rliveMeta: DanmuJsBulletMeta }) | null {
  const baseText = floatingDanmakuText(event);
  if (!baseText) return null;

  const aggregationCount = Math.max(1, Math.floor(options.aggregationCount ?? 1));
  const isSuperChat = event.kind === "super_chat";
  const isPinned = isSuperChat || event.is_self === true;
  const meta: DanmuJsBulletMeta = {
    id: options.id,
    event,
    baseText,
    spans: floatingRichSpans(event),
    aggregationKey: options.aggregationKey,
    aggregationCount,
  };
  return {
    id: options.id,
    ...(isPinned
      ? {
          duration: isSuperChat
            ? superChatDurationMs(event.super_chat)
            : DANMU_JS_DEFAULT_DURATION_MS,
        }
      : { moveV: DANMU_JS_DEFAULT_MOVE_V }),
    mode: isPinned ? "bottom" : "scroll",
    realTime: true,
    prior: isPinned,
    color: Boolean(event.color),
    txt: `${baseText}${aggregateSuffix(aggregationCount)}`,
    elLazyInit: true,
    disableCopyDOM: true,
    style: danmuStyleForEvent(event, options),
    __rliveMeta: meta,
  };
}

function appendText(parent: HTMLElement, text: string): void {
  if (text) parent.appendChild(document.createTextNode(text));
}

function appendRichSpans(parent: HTMLElement, spans: readonly DanmakuContentSpan[]): void {
  for (const span of spans) {
    if (span.type === "text") {
      appendText(parent, span.text);
      continue;
    }

    const imageUrl = normalizeDanmakuImageUrl(span.image_url);
    if (!imageUrl) {
      appendText(parent, "[表情]");
      continue;
    }
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = "";
    image.draggable = false;
    image.loading = "eager";
    image.decoding = "async";
    image.referrerPolicy = BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY;
    image.className = "rlive-danmu-image";
    image.style.width = `${DANMAKU_IMAGE_SCALE}em`;
    image.style.height = `${DANMAKU_IMAGE_SCALE}em`;
    image.style.marginInline = "1px";
    image.style.objectFit = "contain";
    image.style.flex = "0 0 auto";
    image.addEventListener("error", () => image.replaceWith(document.createTextNode("[表情]")), {
      once: true,
    });
    parent.appendChild(image);
  }
}

/** Build a safe custom element for danmu.js' `bulletCreateEl` hook. */
export function createDanmuBulletElement(
  comment: DanmuJsComment & { __rliveMeta?: DanmuJsBulletMeta },
): HTMLElement {
  const meta = comment.__rliveMeta;
  const root = document.createElement("span");
  root.className = "rlive-danmu-bullet";
  root.dataset.rliveDanmakuId = comment.id;
  root.dataset.rliveDanmakuKind = meta?.event.kind ?? "chat";
  root.setAttribute("aria-hidden", "true");
  root.style.pointerEvents = meta?.event.kind === "super_chat" ? "auto" : "none";
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.flexWrap = "nowrap";
  root.style.whiteSpace = "nowrap";

  const content = document.createElement("span");
  content.className = "rlive-danmu-content";
  content.dataset.rliveDanmakuContent = "";
  content.style.display = "inline-flex";
  content.style.alignItems = "center";
  content.style.flexWrap = "nowrap";
  content.style.whiteSpace = "nowrap";
  content.style.flex = "0 0 auto";
  content.style.pointerEvents = "auto";

  if (meta?.spans?.length) appendRichSpans(content, meta.spans);
  else appendText(content, meta?.baseText ?? comment.txt ?? "");
  root.appendChild(content);
  if (meta) meta.contentElement = content;

  if (meta?.aggregationKey) {
    const countSlot = document.createElement("span");
    countSlot.className = "rlive-danmu-count-slot";
    countSlot.dataset.rliveDanmakuCountSlot = "";
    countSlot.style.display = "inline-block";
    countSlot.style.width = "5.25ch";
    countSlot.style.minWidth = "5.25ch";
    countSlot.style.flex = "0 0 5.25ch";
    countSlot.style.whiteSpace = "nowrap";
    countSlot.style.pointerEvents = "none";

    const count = document.createElement("span");
    count.className = "rlive-danmu-count";
    count.dataset.rliveDanmakuCount = "";
    count.style.display = "inline-block";
    count.style.whiteSpace = "nowrap";
    count.style.textAlign = "left";
    count.style.visibility = meta.aggregationCount > 1 ? "visible" : "hidden";
    count.style.pointerEvents = meta.aggregationCount > 1 ? "auto" : "none";
    count.textContent = aggregateSuffix(meta.aggregationCount);
    countSlot.appendChild(count);
    root.appendChild(countSlot);
    meta.countElement = count;
    meta.countSlotElement = countSlot;
  }
  if (meta) meta.element = root;
  return root;
}

export function updateDanmuAggregation(
  comment: DanmuJsComment & { __rliveMeta?: DanmuJsBulletMeta },
  count: number,
): void {
  const meta = comment.__rliveMeta;
  if (!meta) return;
  meta.aggregationCount = Math.max(1, Math.floor(count));
  const suffix = aggregateSuffix(meta.aggregationCount);
  comment.txt = `${meta.baseText}${suffix}`;
  if (meta.countElement) {
    meta.countElement.textContent = suffix;
    meta.countElement.style.visibility = meta.aggregationCount > 1 ? "visible" : "hidden";
    meta.countElement.style.pointerEvents = meta.aggregationCount > 1 ? "auto" : "none";
  }
}

export function updateDanmuAppearance(
  comment: DanmuJsComment & { __rliveMeta?: DanmuJsBulletMeta },
  options: Pick<DanmuJsMappingOptions, "fontSize" | "fontWeight" | "opacity">,
): void {
  const event = comment.__rliveMeta?.event;
  if (!event) return;
  const style = danmuStyleForEvent(event, options);
  comment.style = style;
  const element = comment.__rliveMeta?.element;
  if (!element) return;
  element.style.fontSize = String(style.fontSize ?? "");
  element.style.fontWeight = String(style.fontWeight ?? "");
  element.style.opacity = String(style.opacity ?? "1");
}
