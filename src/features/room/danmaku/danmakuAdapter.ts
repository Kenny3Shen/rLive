import type { DanmakuContentSpan, DanmakuEvent } from "@/shared/types/live";
import type { DanmakuComment } from "./danmakuTypes";
import {
  BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY,
  DANMAKU_IMAGE_FALLBACK_TEXT,
  danmakuImageRequestUrl,
  floatingRichSpans,
  normalizeDanmakuImageUrl,
} from "./content";
import { floatingDanmakuText } from "./filter";
import { superChatDurationMs } from "../superChat";

export const DANMAKU_IMAGE_TRACK_SPAN = 2;
export const DANMAKU_DEFAULT_DURATION_MS = 15_000;
export const DANMAKU_DEFAULT_SPEED = 100;
export const DANMAKU_FONT_WEIGHT = 700;
export const DANMAKU_MAX_AGGREGATED_DISPLAY_COUNT = 9_999;
const DANMAKU_COUNT_SLOT_WIDTH = "5.25ch";

export type DanmakuBulletMeta = {
  id: string;
  event: DanmakuEvent;
  baseText: string;
  spans?: readonly DanmakuContentSpan[];
  trackSpan: number;
  aggregationKey?: string;
  aggregationCount: number;
  element?: HTMLElement;
  contentElement?: HTMLElement;
  countElement?: HTMLElement;
  countSlotElement?: HTMLElement;
};

export type DanmakuCommentWithMeta = DanmakuComment & {
  __rliveMeta: DanmakuBulletMeta;
};

export type DanmakuMappingOptions = {
  id: string;
  fontSize: number;
  fontStroke: number;
  opacity: number;
  laneCount?: number;
  aggregationKey?: string;
  aggregationCount?: number;
};

export type DanmakuAppearanceOptions = Pick<
  DanmakuMappingOptions,
  "fontSize" | "fontStroke" | "opacity" | "laneCount"
>;

export type DanmakuRenderLayer = "scroll" | "top";

export function clampDanmuFontSize(value: number, fallback = 18): number {
  const next = Number.isFinite(value) ? value : fallback;
  return Math.max(12, Math.min(48, Math.round(next)));
}

export function clampDanmuFontStroke(value: number, fallback = 0): number {
  const next = Number.isFinite(value) ? value : fallback;
  const stepped = Math.round(next * 2) / 2;
  return Math.max(0, Math.min(1.5, stepped));
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

export function danmuLaneHeight(fontSize: number): number {
  return Math.max(16, Math.round(clampDanmuFontSize(fontSize) * 1.4));
}

export function danmakuTrackSpan(
  spans: readonly DanmakuContentSpan[] | undefined,
  laneCount?: number,
): number {
  const hasLargeEmote = spans?.some((span) => span.type === "image" && span.large === true);
  if (!hasLargeEmote) return 1;
  const lanes = Number.isFinite(laneCount)
    ? Math.floor(laneCount as number)
    : Number.POSITIVE_INFINITY;
  return lanes >= DANMAKU_IMAGE_TRACK_SPAN ? DANMAKU_IMAGE_TRACK_SPAN : 1;
}

export function danmakuLaneCount(stageHeight: number, laneHeight: number, area: number): number {
  const safeHeight = Number.isFinite(stageHeight) ? Math.max(0, stageHeight) : 0;
  const safeLaneHeight = Math.max(1, Number.isFinite(laneHeight) ? Math.floor(laneHeight) : 16);
  return Math.max(0, Math.floor(Math.floor(safeHeight * clampDanmuArea(area)) / safeLaneHeight));
}

export function danmakuAreaConfig(area: number): number {
  return clampDanmuArea(area);
}

export function isPinnedDanmakuEvent(event: DanmakuEvent): boolean {
  return event.kind === "super_chat" || event.is_self === true;
}

export function danmakuRenderLayer(comment: Pick<DanmakuComment, "mode">): DanmakuRenderLayer {
  return comment.mode === "top" ? "top" : "scroll";
}

/** runtime 的单一 area 数值：固定层占满舞台，滚动层使用用户设置。 */
export function danmakuLayerAreaConfig(layer: DanmakuRenderLayer, scrollArea: number): number {
  return layer === "top" ? 1 : danmakuAreaConfig(scrollArea);
}

export function safeDanmuColor(value: unknown, fallback = "#ffffff"): string {
  if (typeof value !== "string") return fallback;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(?:rgb|hsl)a?\(\s*[\d.%\s,()+-]+\)$/i.test(color)) return color;
  if (/^[a-z]{1,24}$/i.test(color)) return color.toLowerCase();
  return fallback;
}

const SUPER_CHAT_AMOUNT_TIERS = [
  { minimumPrice: 2_000, color: "#B81830" },
  { minimumPrice: 1_000, color: "#E54D4D" },
  { minimumPrice: 500, color: "#E09443" },
  { minimumPrice: 100, color: "#E2B52B" },
  { minimumPrice: 50, color: "#427D9E" },
  { minimumPrice: 30, color: "#2A60B2" },
] as const;

function superChatAmountColor(event: DanmakuEvent): string {
  const price = event.super_chat?.price;
  if (typeof price === "number" && Number.isFinite(price)) {
    const tier = SUPER_CHAT_AMOUNT_TIERS.find(({ minimumPrice }) => price >= minimumPrice);
    if (tier) return tier.color;
  }
  return safeDanmuColor(
    event.super_chat?.background_bottom_color,
    safeDanmuColor(event.super_chat?.background_color, "#2A60B2"),
  );
}

function aggregateSuffix(count: number): string {
  const safeCount = Math.max(1, Math.floor(count));
  if (safeCount <= 1) return "";
  return safeCount > DANMAKU_MAX_AGGREGATED_DISPLAY_COUNT
    ? ` ×${DANMAKU_MAX_AGGREGATED_DISPLAY_COUNT}+`
    : ` ×${safeCount}`;
}

export function danmakuStyleForEvent(
  event: DanmakuEvent,
  options: DanmakuAppearanceOptions,
  trackSpan = 1,
): Record<string, string | number | undefined> {
  const isSuperChat = event.kind === "super_chat";
  const opacity = clampDanmuOpacity(options.opacity);
  const fontStroke = clampDanmuFontStroke(options.fontStroke);
  const span = Math.max(1, Number.isFinite(trackSpan) ? Math.floor(trackSpan) : 1);
  const style: Record<string, string | number | undefined> = {
    boxSizing: "border-box",
    color: isSuperChat ? superChatAmountColor(event) : safeDanmuColor(event.color),
    opacity,
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "nowrap",
    whiteSpace: "nowrap",
    width: "max-content",
    height: `${span * danmuLaneHeight(options.fontSize)}px`,
    "--rlive-emote-scale": String(span),
    maxWidth: "none",
    fontSize: `${clampDanmuFontSize(options.fontSize)}px`,
    fontWeight: DANMAKU_FONT_WEIGHT,
    lineHeight: "1.35",
    textShadow: "0 1px 2px rgba(0,0,0,.92), 0 0 3px rgba(0,0,0,.72)",
    pointerEvents: isSuperChat ? "auto" : "none",
    // 条件键也总是给出：空串按 CSSOM 语义删除属性，样式替换时旧描边不会残留。
    WebkitTextStroke: fontStroke > 0 ? `${fontStroke}px rgba(0,0,0,.92)` : "",
    paintOrder: fontStroke > 0 ? "stroke fill" : "",
  };
  return style;
}

export function danmakuCommentFromEvent(
  event: DanmakuEvent,
  options: DanmakuMappingOptions,
): DanmakuCommentWithMeta | null {
  const baseText = floatingDanmakuText(event);
  if (!baseText) return null;
  const aggregationCount = Math.max(1, Math.floor(options.aggregationCount ?? 1));
  const isSuperChat = event.kind === "super_chat";
  const isPinned = isPinnedDanmakuEvent(event);
  const spans = floatingRichSpans(event);
  const trackSpan = danmakuTrackSpan(spans, options.laneCount);
  const meta: DanmakuBulletMeta = {
    id: options.id,
    event,
    baseText,
    spans,
    trackSpan,
    aggregationKey: options.aggregationKey,
    aggregationCount,
  };
  const comment: DanmakuCommentWithMeta = {
    id: options.id,
    text: `${baseText}${aggregateSuffix(aggregationCount)}`,
    mode: isPinned ? "top" : "scroll",
    duration: isPinned
      ? isSuperChat
        ? superChatDurationMs(event.super_chat)
        : DANMAKU_DEFAULT_DURATION_MS
      : undefined,
    lanes: trackSpan,
    style: danmakuStyleForEvent(event, options, trackSpan),
    __rliveMeta: meta,
    render: () => createDanmuBulletElement(comment),
  };
  return comment;
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
      appendText(parent, DANMAKU_IMAGE_FALLBACK_TEXT);
      continue;
    }
    const image = document.createElement("img");
    image.alt = "";
    image.draggable = false;
    image.loading = "eager";
    image.decoding = "async";
    image.referrerPolicy = BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY;
    image.src = danmakuImageRequestUrl(imageUrl);
    image.className =
      span.large === true ? "rlive-danmu-image rlive-danmu-image-large" : "rlive-danmu-image";
    image.style.marginInline = "1px";
    image.style.objectFit = "contain";
    image.style.flex = "0 0 auto";
    image.addEventListener(
      "error",
      () => {
        if (image.src !== imageUrl) {
          image.src = imageUrl;
          return;
        }
        image.replaceWith(document.createTextNode(DANMAKU_IMAGE_FALLBACK_TEXT));
      },
      { once: false },
    );
    parent.appendChild(image);
  }
}

export function danmuReservesLeadingCountSpacer(
  event: DanmakuEvent,
  aggregationKey: string | undefined,
): boolean {
  return Boolean(aggregationKey) && isPinnedDanmakuEvent(event);
}

export function cssPropertyName(name: string): string {
  if (name.startsWith("--")) return name;
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * 逐条把业务样式写到弹幕的业务节点上。空串按 CSSOM 语义删除该属性，
 * 因此样式构造器必须把条件键（描边）也一并给出，否则旧值会残留在节点上。
 */
export function applyCommentStyle(element: HTMLElement, style: DanmakuComment["style"]): void {
  if (!style || typeof style !== "object") return;
  for (const [name, value] of Object.entries(style)) {
    if (value === undefined) continue;
    element.style.setProperty(cssPropertyName(name), String(value));
  }
}

/** 构建 runtime `render` 使用的安全富文本元素，并自行应用 comment.style。 */
export function createDanmuBulletElement(
  comment: DanmakuComment & { __rliveMeta?: DanmakuBulletMeta },
): HTMLElement {
  const meta = comment.__rliveMeta;
  const root = document.createElement("span");
  root.className = "rlive-danmu-bullet";
  root.dataset.rliveDanmakuId = comment.id;
  root.dataset.rliveDanmakuKind = meta?.event.kind ?? "chat";
  root.setAttribute("aria-hidden", "true");
  applyCommentStyle(root, comment.style);
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
  else appendText(content, meta?.baseText ?? comment.text ?? "");
  root.appendChild(content);
  if (meta) meta.contentElement = content;

  if (meta?.aggregationKey) {
    if (danmuReservesLeadingCountSpacer(meta.event, meta.aggregationKey)) {
      const leadingSpacer = document.createElement("span");
      leadingSpacer.className = "rlive-danmu-count-spacer";
      leadingSpacer.dataset.rliveDanmakuCountSpacer = "";
      leadingSpacer.setAttribute("aria-hidden", "true");
      leadingSpacer.style.display = "inline-block";
      leadingSpacer.style.width = DANMAKU_COUNT_SLOT_WIDTH;
      leadingSpacer.style.minWidth = DANMAKU_COUNT_SLOT_WIDTH;
      leadingSpacer.style.flex = `0 0 ${DANMAKU_COUNT_SLOT_WIDTH}`;
      leadingSpacer.style.pointerEvents = "none";
      root.insertBefore(leadingSpacer, content);
    }
    const countSlot = document.createElement("span");
    countSlot.className = "rlive-danmu-count-slot";
    countSlot.dataset.rliveDanmakuCountSlot = "";
    countSlot.style.display = "inline-block";
    countSlot.style.width = DANMAKU_COUNT_SLOT_WIDTH;
    countSlot.style.minWidth = DANMAKU_COUNT_SLOT_WIDTH;
    countSlot.style.flex = `0 0 ${DANMAKU_COUNT_SLOT_WIDTH}`;
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

export function updateDanmakuAggregation(
  comment: DanmakuComment & { __rliveMeta?: DanmakuBulletMeta },
  count: number,
): void {
  const meta = comment.__rliveMeta;
  if (!meta) return;
  meta.aggregationCount = Math.max(1, Math.floor(count));
  const suffix = aggregateSuffix(meta.aggregationCount);
  comment.text = `${meta.baseText}${suffix}`;
  if (meta.countElement) {
    meta.countElement.textContent = suffix;
    meta.countElement.style.visibility = meta.aggregationCount > 1 ? "visible" : "hidden";
    meta.countElement.style.pointerEvents = meta.aggregationCount > 1 ? "auto" : "none";
  }
}

export function updateDanmakuAppearance(
  comment: DanmakuComment & { __rliveMeta?: DanmakuBulletMeta },
  options: DanmakuAppearanceOptions,
): void {
  const meta = comment.__rliveMeta;
  const event = meta?.event;
  if (!event) return;
  const trackSpan = danmakuTrackSpan(meta.spans, options.laneCount);
  const trackSpanChanged = meta.trackSpan !== trackSpan;
  meta.trackSpan = trackSpan;
  comment.lanes = trackSpan;
  const style = danmakuStyleForEvent(event, options, trackSpan);
  comment.style = style;
  const element = meta.element;
  if (!element) return;
  applyCommentStyle(element, style);
  if (trackSpanChanged) element.style.setProperty("--rlive-emote-scale", String(trackSpan));
}
