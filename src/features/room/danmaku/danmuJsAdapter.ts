import type { CSSProperties } from "react";
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
  const safeCapacity = Math.max(0, Math.floor(capacity));
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
  countElement?: HTMLElement;
};

export type DanmuJsMappingOptions = {
  id: string;
  fontSize: number;
  fontWeight: number;
  opacity: number;
  aggregationKey?: string;
  aggregationCount?: number;
};

export type DanmuJsBandLayout = {
  height: number;
  laneHeight: number;
  laneCount: number;
};

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

/** Preserve the former renderer's area + line-count semantics in a DOM band. */
export function danmuBandLayout(
  stageHeight: number,
  fontSize: number,
  area: number,
  lineCount: number,
): DanmuJsBandLayout {
  if (!Number.isFinite(stageHeight) || stageHeight <= 0) {
    return { height: 0, laneHeight: 0, laneCount: 0 };
  }

  const safeStageHeight = Math.max(1, Math.floor(stageHeight));
  const safeFontSize = clampDanmuFontSize(fontSize);
  const safeArea = Number.isFinite(area) ? Math.max(0.1, Math.min(1, area)) : 0.25;
  const safeLineCount =
    Number.isFinite(lineCount) && lineCount > 0 ? Math.min(20, Math.round(lineCount)) : 0;
  const laneHeight = Math.max(16, Math.round(safeFontSize * 1.4));
  const inset = Math.min(8, Math.max(4, Math.round(safeFontSize * 0.35)));
  const top = Math.min(inset, Math.max(0, safeStageHeight - safeFontSize));
  const usableHeight = Math.max(1, safeStageHeight - top);
  const preferredArea = Math.max(laneHeight, Math.floor(usableHeight * safeArea));
  const automaticLaneCount = Math.max(1, Math.floor(preferredArea / laneHeight));
  const laneCount =
    safeLineCount > 0 ? Math.min(safeLineCount, automaticLaneCount) : automaticLaneCount;
  const bottomPadding = Math.ceil(safeFontSize * 0.45);
  const height = Math.min(safeStageHeight, top + laneCount * laneHeight + bottomPadding);
  return { height: Math.max(1, height), laneHeight, laneCount };
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
    color: safeDanmuColor(event.color, isSuperChat ? "#ffdc73" : "#ffffff"),
    opacity: String(opacity),
    fontSize: `${clampDanmuFontSize(options.fontSize)}px`,
    fontWeight: clampDanmuFontWeight(options.fontWeight),
    lineHeight: "1.35",
    textShadow: "0 1px 2px rgba(0,0,0,.92), 0 0 3px rgba(0,0,0,.72)",
    pointerEvents: "auto",
  };

  if (event.is_self === true) {
    style.border = "1px solid rgba(255,255,255,.86)";
    style.borderRadius = "4px";
    style.padding = "2px 4px";
  }

  if (isSuperChat) {
    style.padding = "4px 10px";
    style.borderRadius = "999px";
    style.backgroundColor = safeDanmuColor(
      event.super_chat?.background_color,
      "rgba(103,67,12,.82)",
    );
    style.border = "1px solid rgba(255,220,115,.72)";
    style.boxShadow = "0 2px 8px rgba(0,0,0,.35)";
    if (event.is_self === true) {
      style.boxShadow =
        "0 0 0 1px rgba(255,255,255,.86) inset, 0 2px 8px rgba(0,0,0,.35)";
    }
  }
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
    duration: isSuperChat ? superChatDurationMs(event.super_chat) : DANMU_JS_DEFAULT_DURATION_MS,
    mode: isSuperChat ? "bottom" : "scroll",
    realTime: true,
    prior: isSuperChat,
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
  root.style.pointerEvents = "auto";
  root.style.display = "inline-flex";
  root.style.alignItems = "center";

  if (meta?.spans?.length) appendRichSpans(root, meta.spans);
  else appendText(root, meta?.baseText ?? comment.txt ?? "");

  if (meta?.aggregationKey) {
    const count = document.createElement("span");
    count.className = "rlive-danmu-count";
    count.dataset.rliveDanmakuCount = "";
    count.style.display = "inline-block";
    count.style.minWidth = "5.25ch";
    count.style.textAlign = "left";
    count.style.visibility = meta.aggregationCount > 1 ? "visible" : "hidden";
    count.textContent = aggregateSuffix(meta.aggregationCount);
    root.appendChild(count);
    meta.countElement = count;
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

export function danmuBandStyle(layout: DanmuJsBandLayout): CSSProperties {
  return { height: layout.height > 0 ? `${layout.height}px` : 0 };
}
