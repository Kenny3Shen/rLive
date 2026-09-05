import type { DanmuJsComment, DanmuJsStyle } from "danmu.js";
import type { DanmakuContentSpan, DanmakuEvent } from "@/shared/types/live";
import {
  BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY,
  DANMAKU_IMAGE_FALLBACK_TEXT,
  DANMAKU_IMAGE_SCALE,
  danmakuImageRequestUrl,
  floatingRichSpans,
  normalizeDanmakuImageUrl,
} from "./content";
import { floatingDanmakuText } from "./filter";
import { superChatDurationMs } from "../superChat";

/**
 * 本地跟踪 bullet 的硬上限，也是自适应预算的下限。
 *
 * 预算只约束我们自己的记账：实际有多少 bullet 上屏由 danmu.js 的车道逻辑决定，
 * 没有空闲车道时它会拒绝评论。占满整个显示区域的高舞台合法地同时承载数百颗
 * 滚动 bullet，低于此值的预算会开始丢弃 danmu.js 本来还装得下的评论。
 */
export const DANMU_JS_MAX_ACTIVE_COMMENTS = 800;
export const DANMU_JS_MIN_ACTIVE_COMMENTS = 120;
/**
 * 单条滚动车道同时可容纳的 bullet 数。当前一颗弹幕头部完全进入舞台后车道才
 * 接受下一条，因此在默认 100 px/s 下，宽舞台上大约同时保持十几颗在途。
 */
export const DANMU_JS_LANE_ACTIVE_COMMENTS = 12;
/**
 * 图片弹幕占据的轨道数。
 *
 * 表情是整块不透明的图片，与上下相邻车道的文字贴在一起时双方都糊掉，
 * 因此带图片的 bullet 预留双倍高度。danmu.js 完全按
 * `ceil(bulletHeight / channelSize)` 决定占用几条轨道（`Channel.addBullet`），
 * 轨道占用因此只能由行盒高度表达。
 */
export const DANMU_JS_IMAGE_TRACK_SPAN = 2;
/**
 * 一条已发送评论在被判为丢弃前可以保持未挂载的时长。
 *
 * `Main.readData` 在所有车道都忙时会把实时评论从其数据池取走并直接丢弃，
 * 不构建 Bullet，该路径既不触发 `bullet_remove` 也不触发 detach 钩子。
 * 除此之外挂载都在 `sendComment` 内同步完成，
 * 因此超过这个窗口仍未挂载的只能是那些静默丢弃。
 */
export const DANMU_JS_ATTACH_TIMEOUT_MS = 1_000;
export const DANMU_JS_MAX_PENDING_COMMENTS = 80;
export const DANMU_JS_MAX_SUPER_CHATS = 3;
export const DANMU_JS_PENDING_MAX_AGE_MS = 5_000;
export const DANMU_JS_DEFAULT_DURATION_MS = 15_000;
export const DANMU_JS_DEFAULT_MOVE_V = 100;
/**
 * 重复计数器的预留宽度，足以容纳最长的后缀（` ×9999+`），
 * 使计数出现或增长时绝不会让旁边的文本回流。
 */
const DANMU_JS_COUNT_SLOT_WIDTH = "5.25ch";
/** Bilibili 直播播放器默认的 `bold: true` 对应的 CSS 数字字重。 */
export const DANMU_JS_FONT_WEIGHT = 700;
export const DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT = 9_999;

export type DanmuJsPendingEvent = {
  event: DanmakuEvent;
  queuedAt: number;
};

/** 加入有界的零尺寸队列一批数据，保留最新的事件。 */
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

/** 仅取出并返回尚未超过时限的待处理事件。 */
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
  /** 占据的轨道数，见 {@link danmuTrackSpan}：表情按它成比例放大。 */
  trackSpan: number;
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
  fontStroke: number;
  opacity: number;
  /**
   * 该 bullet 将落在的图层的车道数，用于给多轨道 bullet 兜底。
   * 省略表示车道充足。
   */
  laneCount?: number;
  aggregationKey?: string;
  aggregationCount?: number;
};

export type DanmuJsAppearanceOptions = Pick<
  DanmuJsMappingOptions,
  "fontSize" | "fontStroke" | "opacity" | "laneCount"
>;

export type DanmuJsRenderLayer = "scroll" | "top";

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

/** 让 danmu.js 的虚拟通道高度与渲染出的行盒保持一致。 */
export function danmuLaneHeight(fontSize: number): number {
  return Math.max(16, Math.round(clampDanmuFontSize(fontSize) * 1.4));
}

/**
 * bullet 占据的轨道数：带大表情（B 站装扮表情、Twitch 第三方表情等）的占
 * {@link DANMU_JS_IMAGE_TRACK_SPAN} 条，其余——含文字与内联小表情的混排——占一条。
 *
 * 车道数不足时退回单轨道：danmu.js 会以 `exceed channels.length` 拒绝
 * 占用超过车道总数的 bullet，否则窄舞台（小窗口叠加最小显示区域）上的
 * 大表情弹幕会一条都不上屏。
 */
export function danmuTrackSpan(
  spans: readonly DanmakuContentSpan[] | undefined,
  laneCount?: number,
): number {
  const hasLargeEmote = spans?.some((span) => span.type === "image" && span.large === true);
  if (!hasLargeEmote) return 1;
  const lanes = Number.isFinite(laneCount) ? Math.floor(laneCount as number) : Number.POSITIVE_INFINITY;
  return lanes >= DANMU_JS_IMAGE_TRACK_SPAN ? DANMU_JS_IMAGE_TRACK_SPAN : 1;
}

/**
 * bullet 的显式行盒高度。
 *
 * danmu.js 在 attach 时用 `getBoundingClientRect().height` 除以 `channelSize`
 * 向上取整得到轨道占用，因此高度必须正好是车道高度的整数倍：写成 em 会因为
 * 车道高度自身的四舍五入多吃一条轨道。文本 bullet 同样显式取一条车道高，
 * 使「高度即轨道占用」成为该层唯一的排版口径。
 */
export function danmuBulletHeight(trackSpan: number, fontSize: number): string {
  const span = Math.max(1, Number.isFinite(trackSpan) ? Math.floor(trackSpan) : 1);
  return `${span * danmuLaneHeight(fontSize)}px`;
}

/** danmu.js 在当前舞台上真正开出的车道数：`floor(stageHeight * area / channelSize)`。 */
export function danmuLaneCount(stageHeight: number, laneHeight: number, area: number): number {
  const safeHeight = Number.isFinite(stageHeight) ? Math.max(0, stageHeight) : 0;
  const safeLaneHeight = Math.max(1, Number.isFinite(laneHeight) ? Math.floor(laneHeight) : 16);
  return Math.max(0, Math.floor(Math.floor(safeHeight * clampDanmuArea(area)) / safeLaneHeight));
}

/**
 * 当前舞台允许同时跟踪的 bullet 数量。
 *
 * 对齐 danmu.js 自身的车道数，使预算随显示面积伸缩，
 * 而不是在大播放器上截断评论。
 */
export function danmuMaxActiveComments(
  stageHeight: number,
  laneHeight: number,
  area: number,
): number {
  const budget = danmuLaneCount(stageHeight, laneHeight, area) * DANMU_JS_LANE_ACTIVE_COMMENTS;
  return Math.min(DANMU_JS_MAX_ACTIVE_COMMENTS, Math.max(DANMU_JS_MIN_ACTIVE_COMMENTS, budget));
}

export type DanmuJsAttachState = {
  sentAt: number;
  attached: boolean;
};

/**
 * danmu.js 接受却从未渲染的评论 id。
 *
 * 见 {@link DANMU_JS_ATTACH_TIMEOUT_MS}：这些记录背后没有 bullet，
 * 丢弃它们释放预算且不带走屏幕上的任何东西。
 */
export function danmuGhostRecordIds(
  order: readonly string[],
  records: ReadonlyMap<string, DanmuJsAttachState>,
  now = Date.now(),
  timeout = DANMU_JS_ATTACH_TIMEOUT_MS,
): string[] {
  const safeTimeout = Math.max(0, Number.isFinite(timeout) ? timeout : DANMU_JS_ATTACH_TIMEOUT_MS);
  const ghosts: string[] = [];
  for (const id of order) {
    const record = records.get(id);
    if (!record || record.attached) continue;
    if (now - record.sentAt > safeTimeout) ghosts.push(id);
  }
  return ghosts;
}

/** 把请求的 px/s 转换为 danmu.js 相对 100 px/s 基准 moveV 的倍率。 */
export function danmuMoveVPlayRate(moveV: number): number {
  const safeMoveV = Number.isFinite(moveV) && moveV > 0 ? moveV : DANMU_JS_DEFAULT_MOVE_V;
  return safeMoveV / DANMU_JS_DEFAULT_MOVE_V;
}

/** 使用 danmu.js 原生的比例式 area，不用 `lines` 覆盖它。 */
export function danmuAreaConfig(area: number): { start: number; end: number } {
  return { start: 0, end: clampDanmuArea(area) };
}

/**
 * 事件是否作为顶层固定弹幕渲染。
 *
 * 它们从不竞争滚动车道且有自身上限（SC 有各自上限，自己发送的受顶部车道限制），
 * 因此活动预算不适用于它们。
 */
export function isPinnedDanmakuEvent(event: DanmakuEvent): boolean {
  return event.kind === "super_chat" || event.is_self === true;
}

/** 固定弹幕与配置的滚动区域相互独立。 */
export function danmuRenderLayer(comment: Pick<DanmuJsComment, "mode">): DanmuJsRenderLayer {
  return comment.mode === "top" ? "top" : "scroll";
}

export function danmuLayerAreaConfig(
  layer: DanmuJsRenderLayer,
  scrollArea: number,
): { start: number; end: number } {
  return layer === "top" ? { start: 0, end: 1 } : danmuAreaConfig(scrollArea);
}

/** 原生负载进入内联 CSS 之前只接受紧凑的颜色值。 */
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
  return safeCount > DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT
    ? ` ×${DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT}+`
    : ` ×${safeCount}`;
}

export function danmuStyleForEvent(
  event: DanmakuEvent,
  options: DanmuJsAppearanceOptions,
  trackSpan = 1,
): DanmuJsStyle {
  const isSuperChat = event.kind === "super_chat";
  const opacity = clampDanmuOpacity(options.opacity);
  const fontStroke = clampDanmuFontStroke(options.fontStroke);
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
    // 行盒高度就是 danmu.js 的轨道占用，见 `danmuBulletHeight`。
    height: danmuBulletHeight(trackSpan, options.fontSize),
    fontSize: `${clampDanmuFontSize(options.fontSize)}px`,
    fontWeight: DANMU_JS_FONT_WEIGHT,
    lineHeight: "1.35",
    textShadow: "0 1px 2px rgba(0,0,0,.92), 0 0 3px rgba(0,0,0,.72)",
    pointerEvents: isSuperChat ? "auto" : "none",
  };

  if (fontStroke > 0) {
    // danmu.js 自己把 camelCase 键转成 CSS 文本。大写 W 是必须的，
    // 这样才能生成 `-webkit-text-stroke` 而不是非法的无前缀
    // `webkit-text-stroke`。
    style.WebkitTextStroke = `${fontStroke}px rgba(0,0,0,.92)`;
    // 先画填充再画描边顺序相反：小字号文本才能保住完整的内部笔画，
    // 不被居中式 CSS 描边吃掉细线。
    style.paintOrder = "stroke fill";
  }

  return style;
}

/** 映射一条已校验的直播事件，但不把其 Unix 时间戳引入媒体时间轴。 */
export function danmuCommentFromEvent(
  event: DanmakuEvent,
  options: DanmuJsMappingOptions,
): (DanmuJsComment & { __rliveMeta: DanmuJsBulletMeta }) | null {
  const baseText = floatingDanmakuText(event);
  if (!baseText) return null;

  const aggregationCount = Math.max(1, Math.floor(options.aggregationCount ?? 1));
  const isSuperChat = event.kind === "super_chat";
  const isPinned = isPinnedDanmakuEvent(event);
  const spans = floatingRichSpans(event);
  const trackSpan = danmuTrackSpan(spans, options.laneCount);
  const meta: DanmuJsBulletMeta = {
    id: options.id,
    event,
    baseText,
    spans,
    trackSpan,
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
    mode: isPinned ? "top" : "scroll",
    realTime: true,
    prior: isPinned,
    color: Boolean(event.color),
    txt: `${baseText}${aggregateSuffix(aggregationCount)}`,
    elLazyInit: true,
    disableCopyDOM: true,
    style: danmuStyleForEvent(event, options, trackSpan),
    __rliveMeta: meta,
  };
}

function appendText(parent: HTMLElement, text: string): void {
  if (text) parent.appendChild(document.createTextNode(text));
}

function appendRichSpans(
  parent: HTMLElement,
  spans: readonly DanmakuContentSpan[],
  trackSpan: number,
): void {
  // 大表情跟着轨道成比例放大：每条轨道 `DANMAKU_IMAGE_SCALE`em，与单轨道时
  // 相同的呼吸空间；内联小表情永远保持单轨道尺寸。大表情始终装得下预留的
  // 行盒 —— 字号下限 12px 起，`span × 1.35em` 都小于 `span × round(1.4 × fontSize)`。
  const largeEdge = `${trackSpan * DANMAKU_IMAGE_SCALE}em`;
  const inlineEdge = `${DANMAKU_IMAGE_SCALE}em`;
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
    // 放在策略之后设置：策略只对尚未发出的请求生效，
    // 且在代理未启动、使用直连 CDN URL 时仍然重要。
    image.src = danmakuImageRequestUrl(imageUrl);
    image.className =
      span.large === true ? "rlive-danmu-image rlive-danmu-image-large" : "rlive-danmu-image";
    // 标记的 class 供字号/车道变化时按各自尺寸重写，见 `updateDanmuAppearance`。
    const imageEdge = span.large === true ? largeEdge : inlineEdge;
    image.style.width = imageEdge;
    image.style.height = imageEdge;
    image.style.marginInline = "1px";
    image.style.objectFit = "contain";
    image.style.flex = "0 0 auto";
    image.addEventListener(
      "error",
      () => {
        // 代理宕机不应让表情失去图片：退回文本标记前先对 CDN 重试一次。
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

/**
 * bullet 是否需要一个与其重复计数槽位等宽的前导垫片。
 *
 * danmu.js 通过整体偏移测量宽度的一半来居中固定弹幕（`Bullet.startMove` 中
 * `left: 50%` + `margin-left: -width/2`），因此尾部预留的计数槽位会把可见文本
 * 推到中心左侧半个槽位处。等宽的前导垫片恢复平衡。滚动 bullet 锚定左边缘，
 * 不需要。
 */
export function danmuReservesLeadingCountSpacer(
  event: DanmakuEvent,
  aggregationKey: string | undefined,
): boolean {
  return Boolean(aggregationKey) && isPinnedDanmakuEvent(event);
}

/** 为 danmu.js 的 `bulletCreateEl` 钩子构建安全的自定义元素。 */
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

  if (meta?.spans?.length) appendRichSpans(content, meta.spans, meta.trackSpan);
  else appendText(content, meta?.baseText ?? comment.txt ?? "");
  root.appendChild(content);
  if (meta) meta.contentElement = content;

  if (meta?.aggregationKey) {
    if (danmuReservesLeadingCountSpacer(meta.event, meta.aggregationKey)) {
      const leadingSpacer = document.createElement("span");
      leadingSpacer.className = "rlive-danmu-count-spacer";
      leadingSpacer.dataset.rliveDanmakuCountSpacer = "";
      leadingSpacer.setAttribute("aria-hidden", "true");
      leadingSpacer.style.display = "inline-block";
      leadingSpacer.style.width = DANMU_JS_COUNT_SLOT_WIDTH;
      leadingSpacer.style.minWidth = DANMU_JS_COUNT_SLOT_WIDTH;
      leadingSpacer.style.flex = `0 0 ${DANMU_JS_COUNT_SLOT_WIDTH}`;
      leadingSpacer.style.pointerEvents = "none";
      root.insertBefore(leadingSpacer, content);
    }

    const countSlot = document.createElement("span");
    countSlot.className = "rlive-danmu-count-slot";
    countSlot.dataset.rliveDanmakuCountSlot = "";
    countSlot.style.display = "inline-block";
    countSlot.style.width = DANMU_JS_COUNT_SLOT_WIDTH;
    countSlot.style.minWidth = DANMU_JS_COUNT_SLOT_WIDTH;
    countSlot.style.flex = `0 0 ${DANMU_JS_COUNT_SLOT_WIDTH}`;
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
  options: DanmuJsAppearanceOptions,
): void {
  const meta = comment.__rliveMeta;
  const event = meta?.event;
  if (!event) return;
  const trackSpan = danmuTrackSpan(meta?.spans, options.laneCount);
  const trackSpanChanged = meta !== undefined && meta.trackSpan !== trackSpan;
  if (meta) meta.trackSpan = trackSpan;
  const style = danmuStyleForEvent(event, options, trackSpan);
  comment.style = style;
  const element = meta?.element;
  if (!element) return;
  element.style.fontSize = String(style.fontSize ?? "");
  // 字号变了车道高度就变了，行盒必须跟着走，否则轨道占用与车道对不上。
  element.style.height = String(style.height ?? "");
  element.style.fontWeight = String(style.fontWeight ?? "");
  element.style.opacity = String(style.opacity ?? "1");
  if (style.WebkitTextStroke === undefined) {
    element.style.removeProperty("-webkit-text-stroke");
    element.style.removeProperty("paint-order");
  } else {
    element.style.setProperty("-webkit-text-stroke", String(style.WebkitTextStroke));
    element.style.setProperty("paint-order", String(style.paintOrder));
  }
  // 表情边长用 em，字号变化自动跟随；只有轨道数翻转（车道数掉到两条以下）
  // 才需要重写已上屏 bullet 里的图片。大表情按新轨道数缩放，
  // 内联小表情回到单轨道尺寸。
  if (trackSpanChanged) {
    const largeEdge = `${trackSpan * DANMAKU_IMAGE_SCALE}em`;
    const inlineEdge = `${DANMAKU_IMAGE_SCALE}em`;
    for (const image of element.querySelectorAll<HTMLElement>(".rlive-danmu-image")) {
      const imageEdge = image.classList.contains("rlive-danmu-image-large")
        ? largeEdge
        : inlineEdge;
      image.style.width = imageEdge;
      image.style.height = imageEdge;
    }
  }
}
