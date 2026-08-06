import type { DanmakuContentSpan, DanmakuEvent } from "@/shared/types/live";
import {
  createDanmakuContentAggregator,
  DANMAKU_CONTENT_AGGREGATION_WINDOW_MAX_MS,
  DANMAKU_CONTENT_AGGREGATION_WINDOW_MS,
  DANMAKU_CONTENT_AGGREGATION_WINDOW_MIN_MS,
  floatingDanmakuText,
  shouldShowOnCanvas,
} from "../danmaku/filter";
import {
  DANMAKU_IMAGE_HORIZONTAL_GAP,
  DANMAKU_IMAGE_SCALE,
  richDanmakuContent,
  withDanmakuContentSuffix,
} from "../danmaku/content";

export type TrackItem = {
  id: string;
  text: string;
  /**
   * Ordered Bilibili image-emote fragments. The canvas uses `text` until all
   * images are ready, so a slow or failed CDN image never makes a message
   * disappear.
   */
  richSpans?: readonly DanmakuContentSpan[];
  color: string;
  /** Whether this item came from the locally saved account. */
  isSelf: boolean;
  /** Top-left y position in CSS pixels. */
  y: number;
  /** Left x position in CSS pixels. */
  x: number;
  width: number;
  speed: number; // px/sec
  fontSize: number;
  kind: "scroll" | "top";
  /** Scroll lane index. Fixed-top messages do not occupy a lane. */
  lane?: number;
  /** Top items expire after this timestamp (ms). */
  expireAt?: number;
};

export type DanmakuEngine = {
  /**
   * `alreadyVisible` is used by the canvas listener after it has run the
   * shared filter. Keeping the regular path defensive still makes direct
   * engine callers safe, while avoiding duplicate validation on every IPC
   * event in a busy room.
   */
  push: (ev: DanmakuEvent, alreadyVisible?: boolean) => void;
  /** Enqueues a transport batch and schedules it only once. */
  pushBatch: (events: readonly DanmakuEvent[], alreadyVisible?: boolean) => void;
  tick: (dt: number, width: number, height: number) => void;
  /**
   * The engine owns this array. Consumers must only read it during a render
   * pass; returning the backing array avoids a short-lived copy on every
   * animation frame.
   */
  visibleItems: () => readonly TrackItem[];
  /** Whether the canvas needs another frame to move or expire an item. */
  hasWork: () => boolean;
  setOpts: (opts: DanmakuEngineOptions) => void;
  opacity: () => number;
  fontWeight: () => number;
  /**
   * Lightweight scheduling counters for deterministic pressure tests. They
   * are only incremented when the engine is created with `debug: true`.
   */
  debugStats: () => DanmakuEngineStats;
};

export type DanmakuEngineStats = {
  /** Number of passes that attempted to put queued comments into lanes. */
  schedulePasses: number;
  /** Calls skipped because the queue head cannot be safe before a later tick. */
  scheduleSkips: number;
  /** Number of lanes considered by collision scheduling. */
  laneChecks: number;
  /** Number of existing scrolling items considered by collision scheduling. */
  laneItemChecks: number;
  activeItems: number;
  pendingItems: number;
};

export type DanmakuEngineOptions = {
  fontSize: number;
  speed: number;
  opacity: number;
  /** Portion of the player height occupied by scrolling danmaku. */
  area?: number;
  /** Maximum visible lanes; zero lets the engine choose automatically. */
  lineCount?: number;
  /** CSS-compatible canvas font weight. */
  fontWeight?: number;
  /** Combine matching normal-chat content into one floating item. */
  aggregateRepeats?: boolean;
  /** Sliding window for `aggregateRepeats`, in milliseconds. */
  aggregateWindowMs?: number;
  /** Distinct canvas-safe color used for messages from the local account. */
  selfColor?: string;
  /** Test/diagnostic only: collect scheduling counters without production overhead. */
  debug?: boolean;
};

type PendingScroll = Omit<TrackItem, "kind" | "lane" | "x" | "y"> & {
  queuedAt: number;
  active: boolean;
  aggregationKey?: string;
  aggregationBaseId?: string;
  aggregationReservedWidth?: number;
  aggregationBaseRichSpans?: readonly DanmakuContentSpan[];
};

type EngineTrackItem = TrackItem & {
  /** O(1) removal from the render list when the 80-item cap is reached. */
  itemIndex: number;
  /** Stale entries in the amortized scroll eviction queue are marked inactive. */
  active: boolean;
  aggregationKey?: string;
  aggregationBaseId?: string;
  aggregationReservedWidth?: number;
  aggregationBaseRichSpans?: readonly DanmakuContentSpan[];
};

type AggregationTarget = Pick<TrackItem, "id" | "text" | "richSpans" | "width" | "fontSize"> & {
  active: boolean;
  aggregationKey?: string;
  aggregationBaseId?: string;
  aggregationReservedWidth?: number;
  aggregationBaseRichSpans?: readonly DanmakuContentSpan[];
};

type LaneLayout = {
  count: number;
  laneHeight: number;
  top: number;
};

const MAX_ITEMS = 80;
const MAX_PENDING_ITEMS = 80;
const MAX_QUEUE_AGE_MS = 5000;
const TOP_DURATION_MS = 3000;
const DEFAULT_SCROLL_AREA_RATIO = 0.9;
const SPAWN_PADDING = 12;
const TOP_PADDING = 12;
const DEFAULT_SELF_DANMAKU_COLOR = "#ffd166";
// A fixed suffix reservation lets an aggregated item reveal a growing count
// without moving into either neighbour on its lane. The cap is far beyond a
// practical five-second burst; pathological counts use the `+` form.
const MAX_AGGREGATED_DISPLAY_COUNT = 9_999;

function measureTextAdvance(text: string, fontSize: number): number {
  // Approximate CJK-friendly width without a canvas context.
  let width = 0;
  for (const char of text) {
    width += char.charCodeAt(0) > 255 ? fontSize : fontSize * 0.55;
  }
  return width;
}

function measureWidth(text: string, fontSize: number): number {
  const width = measureTextAdvance(text, fontSize);
  return Math.max(fontSize, width + 8);
}

function measureRichWidth(spans: readonly DanmakuContentSpan[], fontSize: number): number {
  let width = 8;
  for (const span of spans) {
    width +=
      span.type === "image"
        ? fontSize * DANMAKU_IMAGE_SCALE + DANMAKU_IMAGE_HORIZONTAL_GAP
        : measureTextAdvance(span.text, fontSize);
  }
  return Math.max(fontSize, width);
}

function aggregateSuffix(count: number): string {
  const boundedCount = Math.max(1, Math.floor(count));
  if (boundedCount === 1) return "";
  const suffix =
    boundedCount > MAX_AGGREGATED_DISPLAY_COUNT
      ? `${MAX_AGGREGATED_DISPLAY_COUNT}+`
      : `${boundedCount}`;
  return ` ×${suffix}`;
}

function aggregatedText(content: string, count: number): string {
  return `${content}${aggregateSuffix(count)}`;
}

function floatingRichSpans(event: DanmakuEvent): readonly DanmakuContentSpan[] | undefined {
  const richSpans = richDanmakuContent(event.spans);
  if (!richSpans) return undefined;

  // `floatingDanmakuText` prepends the SC marker. Mirror that fallback text
  // in the rich representation so either rendering path communicates the
  // same message semantics.
  if (event.kind === "super_chat" && !event.content.trim().startsWith("【SC】")) {
    return [{ type: "text", text: "【SC】" }, ...richSpans];
  }
  return richSpans;
}

function richSpansWithAggregateSuffix(
  spans: readonly DanmakuContentSpan[] | undefined,
  count: number,
): readonly DanmakuContentSpan[] | undefined {
  if (!spans) return undefined;
  const suffix = aggregateSuffix(count);
  return suffix ? withDanmakuContentSuffix(spans, suffix) : spans;
}

function measureTrackWidth(
  text: string,
  richSpans: readonly DanmakuContentSpan[] | undefined,
  fontSize: number,
): number {
  const textWidth = measureWidth(text, fontSize);
  if (!richSpans) return textWidth;

  // The canvas draws the original text while an image-emote CDN request is
  // pending or has failed. A raw Bilibili token such as `[xxx_问号]` can be
  // much wider than its final 1.35em image, so reserve both forms to avoid a
  // temporary collision with another item in the same lane.
  return Math.max(textWidth, measureRichWidth(richSpans, fontSize));
}

function speedPx(logical: number, fontSize: number): number {
  // logical 1–10 → ~80–220 px/s
  const speed = Math.max(1, Math.min(10, logical || 8));
  return 60 + speed * 16 + fontSize * 0.5;
}

function clampFontSize(value: number): number {
  return Math.max(12, Math.min(48, value || 18));
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAggregateWindowMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DANMAKU_CONTENT_AGGREGATION_WINDOW_MS;
  return Math.min(
    DANMAKU_CONTENT_AGGREGATION_WINDOW_MAX_MS,
    Math.max(DANMAKU_CONTENT_AGGREGATION_WINDOW_MIN_MS, Math.round(value as number)),
  );
}

function clampArea(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SCROLL_AREA_RATIO;
  return Math.max(0.1, Math.min(1, value ?? DEFAULT_SCROLL_AREA_RATIO));
}

function clampLineCount(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 0) return 0;
  return Math.min(20, Math.round(value));
}

function clampFontWeight(value: number | undefined): number {
  const weight = Number.isFinite(value) ? (value ?? 600) : 600;
  if (weight < 450) return 400;
  if (weight < 550) return 500;
  if (weight < 650) return 600;
  return 700;
}

function selfDanmakuColor(value: string | undefined): string {
  const color = value?.trim();
  return color || DEFAULT_SELF_DANMAKU_COLOR;
}

/** First-fit order from the top edge down, matching Simple Live's tracks. */
function createTopDownLaneOrder(count: number): number[] {
  return Array.from({ length: count }, (_, lane) => lane);
}

function layoutFor(height: number, fontSize: number, area: number, lineCount: number): LaneLayout {
  const safeHeight = Math.max(1, Math.floor(height));
  const laneHeight = Math.max(fontSize + 9, 24);
  const top = Math.min(TOP_PADDING, Math.max(0, safeHeight - fontSize));
  const usableHeight = Math.max(1, safeHeight - top);
  const preferredArea = Math.max(laneHeight, Math.floor(usableHeight * area));
  const autoCount = Math.max(1, Math.floor(preferredArea / laneHeight));
  const count = lineCount > 0 ? Math.min(lineCount, autoCount) : autoCount;
  return {
    count,
    laneHeight,
    top,
  };
}

function sameLayout(first: LaneLayout | null, second: LaneLayout): boolean {
  return (
    first !== null &&
    first.count === second.count &&
    first.laneHeight === second.laneHeight &&
    first.top === second.top
  );
}

function laneY(lane: number, layout: LaneLayout): number {
  return layout.top + lane * layout.laneHeight;
}

function remapLane(lane: number, previousCount: number, nextCount: number): number {
  if (previousCount <= 1 || nextCount <= 1) return 0;

  const position = Math.max(0, Math.min(1, lane / (previousCount - 1)));
  return Math.round(position * (nextCount - 1));
}

/** Keep a scrolling item at the same point along its right-to-left journey. */
function remapScrollXForViewportWidth(
  item: TrackItem,
  previousWidth: number,
  nextWidth: number,
): number {
  const oldStart = previousWidth + SPAWN_PADDING;
  const newStart = nextWidth + SPAWN_PADDING;
  const exit = -item.width - 20;
  const oldDistance = oldStart - exit;
  const progress = Math.max(0, Math.min(1, (oldStart - item.x) / oldDistance));
  const mapped = newStart - progress * (newStart - exit);
  const wasVisible = item.x < previousWidth && item.x + item.width > 0;

  // A message that was already on screen must stay on screen after the
  // viewport narrows. Its normal trajectory can otherwise leave it just to
  // the right of the smaller canvas for a few frames, which reads as a
  // premature disappearance during a window drag.
  if (!wasVisible) return mapped;
  return Math.min(nextWidth - 0.5, Math.max(-item.width + 0.5, mapped));
}

export function createEngine(opts: DanmakuEngineOptions): DanmakuEngine {
  let fontSize = clampFontSize(opts.fontSize);
  let logicalSpeed = opts.speed;
  let currentOpacity = clampOpacity(opts.opacity);
  let scrollArea = clampArea(opts.area);
  let maxLineCount = clampLineCount(opts.lineCount);
  let currentFontWeight = clampFontWeight(opts.fontWeight);
  let aggregateRepeats = opts.aggregateRepeats === true;
  let aggregateWindowMs = clampAggregateWindowMs(opts.aggregateWindowMs);
  let currentSelfColor = selfDanmakuColor(opts.selfColor);
  let contentAggregator = createDanmakuContentAggregator(aggregateRepeats, aggregateWindowMs);
  const aggregationTargets = new Map<string, AggregationTarget>();
  let items: EngineTrackItem[] = [];
  let pending: PendingScroll[] = [];
  // Keep a head cursor instead of shifting the array for every scheduled
  // comment. At a busy room this queue is touched much more often than it is
  // compacted, and Array#shift repeatedly moves all remaining entries.
  let pendingHead = 0;
  // A blocked queue head cannot become safe until leading comments move. Do
  // not repeat the same collision scan for each incoming IPC event; tick()
  // decrements this estimate and retries at the first useful animation frame.
  let pendingBlocked = false;
  let pendingRetrySeconds = 0;
  let pendingRetryOnNextTick = false;
  let sequence = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let layout: LaneLayout | null = null;
  let laneOrder: number[] = [];
  // Each lane keeps only its own active scroll messages. The old scheduler
  // scanned the complete item list once per lane, which is O(lanes × items)
  // for every queued message under load.
  let laneItems: EngineTrackItem[][] = [];
  // Insertion-order queue used only when the global visible-item cap is
  // reached. Its head advances monotonically, so evicting a scroll comment
  // never needs Array#findIndex over the render list.
  let scrollItems: EngineTrackItem[] = [];
  let scrollItemHead = 0;
  let laneCursor = 0;
  // Layout is a function of the viewport height, active font sizes and the
  // two layout settings. Recomputing it on every animation frame used to scan
  // every item even when nothing had changed.
  let layoutDirty = true;
  let largestScrollFontSize = fontSize;
  let largestScrollFontSizeNeedsRefresh = false;
  const collectDebugStats = opts.debug === true;
  let schedulePasses = 0;
  let scheduleSkips = 0;
  let laneChecks = 0;
  let laneItemChecks = 0;

  function pendingCount(): number {
    return pending.length - pendingHead;
  }

  function resetPendingScheduling(): void {
    pendingBlocked = false;
    pendingRetrySeconds = 0;
    pendingRetryOnNextTick = false;
  }

  function forgetAggregationTarget(target: AggregationTarget): void {
    target.active = false;
    const key = target.aggregationKey;
    if (!key || aggregationTargets.get(key) !== target) return;
    aggregationTargets.delete(key);
    contentAggregator.forget(key);
  }

  function replaceAggregationTarget(previous: PendingScroll, next: EngineTrackItem): void {
    previous.active = false;
    const key = previous.aggregationKey;
    if (!key || aggregationTargets.get(key) !== previous) return;
    next.aggregationKey = key;
    next.aggregationBaseId = previous.aggregationBaseId;
    next.aggregationBaseRichSpans = previous.aggregationBaseRichSpans;
    aggregationTargets.set(key, next);
  }

  function updateAggregatedTarget(target: AggregationTarget, content: string, count: number): void {
    const nextText = aggregatedText(content, count);
    // Once a pathological burst reaches the capped display label, further
    // count changes have no visual effect and should not churn raster keys.
    if (target.text === nextText) return;
    const nextRichSpans = richSpansWithAggregateSuffix(target.aggregationBaseRichSpans, count);
    const nextWidth = measureTrackWidth(nextText, nextRichSpans, target.fontSize);
    // The initial item reserves room for the largest display suffix. Keeping
    // its bounds fixed avoids widening left into the leading comment or right
    // into a later comment on the same lane.
    target.text = nextText;
    target.richSpans = nextRichSpans;
    target.width = Math.max(nextWidth, target.aggregationReservedWidth ?? nextWidth);
    const baseId = target.aggregationBaseId ?? target.id;
    target.aggregationBaseId = baseId;
    // Canvas raster entries are keyed by id, so a bounded count update needs
    // a new key to redraw the existing floating item with its new suffix.
    target.id = `${baseId}-x${count}`;
  }

  function compactPending(): void {
    if (pendingHead === 0) return;
    if (pendingHead >= pending.length) {
      pending = [];
      pendingHead = 0;
      return;
    }
    // Small head offsets are cheaper to keep than a new backing array. Once
    // at least half the entries are consumed, compact the bounded queue.
    if (pendingHead < 24 && pendingHead * 2 < pending.length) return;
    pending = pending.slice(pendingHead);
    pendingHead = 0;
  }

  function discardExpiredPending(now: number): boolean {
    const initialHead = pendingHead;
    while (pendingHead < pending.length && now - pending[pendingHead].queuedAt > MAX_QUEUE_AGE_MS) {
      forgetAggregationTarget(pending[pendingHead]);
      pendingHead += 1;
    }
    if (pendingHead === initialHead) return false;
    compactPending();
    resetPendingScheduling();
    return true;
  }

  function rebuildLaneItems(count: number): void {
    const nextLaneItems = Array.from({ length: count }, () => [] as EngineTrackItem[]);
    for (const item of items) {
      if (item.kind !== "scroll" || item.lane === undefined) continue;
      const lane = nextLaneItems[item.lane];
      if (lane) lane.push(item);
    }
    laneItems = nextLaneItems;
  }

  function removeFromLane(item: EngineTrackItem): void {
    if (item.kind !== "scroll" || item.lane === undefined) return;
    const lane = laneItems[item.lane];
    if (!lane) return;
    const index = lane.indexOf(item);
    if (index >= 0) lane.splice(index, 1);
  }

  function appendItem(item: EngineTrackItem): void {
    item.active = true;
    item.itemIndex = items.length;
    items.push(item);
    if (item.kind !== "scroll") return;
    laneItems[item.lane ?? 0]?.push(item);
    scrollItems.push(item);
  }

  function compactScrollItems(force = false): void {
    if (scrollItemHead >= scrollItems.length) {
      scrollItems = [];
      scrollItemHead = 0;
      return;
    }
    // Removed entries can only accumulate when comments naturally leave the
    // screen. Rebuild this small queue occasionally, never per incoming event.
    if (!force && scrollItems.length <= MAX_ITEMS * 3 && scrollItemHead < 24) return;
    const next: EngineTrackItem[] = [];
    for (let index = scrollItemHead; index < scrollItems.length; index += 1) {
      const item = scrollItems[index];
      if (item.active) next.push(item);
    }
    scrollItems = next;
    scrollItemHead = 0;
  }

  function takeOldestScrollItem(): EngineTrackItem | undefined {
    while (scrollItemHead < scrollItems.length) {
      const item = scrollItems[scrollItemHead];
      scrollItemHead += 1;
      if (item.active) {
        compactScrollItems();
        return item;
      }
    }
    compactScrollItems();
    return undefined;
  }

  function refreshLargestScrollFontSize(): number {
    let largest = fontSize;
    for (const item of items) {
      if (item.kind === "scroll" && item.fontSize > largest) {
        largest = item.fontSize;
      }
    }
    largestScrollFontSize = largest;
    largestScrollFontSizeNeedsRefresh = false;
    return largestScrollFontSize;
  }

  function noteRemovedItem(item: TrackItem | undefined): void {
    if (item?.kind === "scroll" && item.fontSize >= largestScrollFontSize) {
      // This is deliberately lazy: a scan is only needed if an item that may
      // have determined the lane height actually leaves the screen.
      largestScrollFontSizeNeedsRefresh = true;
      layoutDirty = true;
    }
  }

  function refreshLayout(): LaneLayout | null {
    if (viewportHeight <= 0) return null;

    if (!layoutDirty && layout) return layout;

    const largestFontSize = largestScrollFontSizeNeedsRefresh
      ? refreshLargestScrollFontSize()
      : largestScrollFontSize;

    // Existing messages retain the size they had at insertion. Keep enough
    // vertical room for them while a setting change is still on screen.
    const nextLayout = layoutFor(viewportHeight, largestFontSize, scrollArea, maxLineCount);
    if (sameLayout(layout, nextLayout)) {
      layoutDirty = false;
      return layout;
    }

    const previousLayout = layout;
    if (previousLayout) {
      // Items are engine-private, so this can update them in place instead of
      // allocating a replacement array during resize/layout changes.
      for (const item of items) {
        if (item.kind !== "scroll") continue;

        const oldLane = item.lane ?? 0;
        const lane = remapLane(oldLane, previousLayout.count, nextLayout.count);
        item.lane = lane;
        item.y = laneY(lane, nextLayout);
      }
    }

    layout = nextLayout;
    laneOrder = createTopDownLaneOrder(nextLayout.count);
    rebuildLaneItems(nextLayout.count);
    laneCursor %= laneOrder.length;
    layoutDirty = false;
    // A resize or live line-count change may open a lane immediately.
    resetPendingScheduling();
    return layout;
  }

  function minTailGap(candidate: PendingScroll): number {
    return Math.max(24, Math.round(candidate.fontSize * 1.4));
  }

  /**
   * Returns how long this lane needs before a candidate is safe, or zero when
   * it is safe now. The equivalent no-catch-up condition is calculated as a
   * position threshold, avoiding the old pair of divisions for every item.
   */
  function laneRetryAfter(lane: number, candidate: PendingScroll): number {
    if (collectDebugStats) laneChecks += 1;
    const existingItems = laneItems[lane];
    if (!existingItems || existingItems.length === 0) return 0;

    const spawnX = viewportWidth + SPAWN_PADDING;
    const gap = minTailGap(candidate);
    const staticTailLimit = Math.max(0, spawnX - gap);
    let retryAfter = 0;

    for (const item of existingItems) {
      if (collectDebugStats) laneItemChecks += 1;
      const leadingRight = item.x + item.width;
      if (leadingRight <= 0) continue;

      // If the candidate is faster, it must leave enough room that it cannot
      // catch this leading item before that item exits. Algebraically this is
      // `leadingRight <= item.speed * (spawnX - gap) / candidate.speed`.
      // Slower/equal candidates only need the tail-gap boundary itself.
      const safeRightLimit =
        candidate.speed > item.speed
          ? Math.max(0, (item.speed * staticTailLimit) / candidate.speed)
          : staticTailLimit;
      if (leadingRight <= safeRightLimit) continue;

      retryAfter = Math.max(retryAfter, (leadingRight - safeRightLimit) / item.speed);
    }
    return retryAfter;
  }

  function findSafeLane(candidate: PendingScroll): number | null {
    let earliestRetry = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < laneOrder.length; offset += 1) {
      const orderIndex = (laneCursor + offset) % laneOrder.length;
      const lane = laneOrder[orderIndex];
      const retryAfter = laneRetryAfter(lane, candidate);
      if (retryAfter <= 0) {
        laneCursor = (orderIndex + 1) % laneOrder.length;
        return lane;
      }
      earliestRetry = Math.min(earliestRetry, retryAfter);
    }

    pendingRetrySeconds = Number.isFinite(earliestRetry) ? earliestRetry : 0;
    return null;
  }

  function removeItemAt(index: number): EngineTrackItem | undefined {
    if (index < 0 || index >= items.length) return undefined;
    const lastIndex = items.length - 1;
    const removed = items[index];
    const lastItem = items[lastIndex];
    items.pop();
    if (index !== lastIndex) {
      items[index] = lastItem;
      lastItem.itemIndex = index;
    }
    forgetAggregationTarget(removed);
    if (removed.kind === "scroll") {
      removeFromLane(removed);
      resetPendingScheduling();
    }
    noteRemovedItem(removed);
    return removed;
  }

  function makeRoomForItem(): void {
    while (items.length >= MAX_ITEMS) {
      const oldestScroll = takeOldestScrollItem();
      if (oldestScroll) {
        removeItemAt(oldestScroll.itemIndex);
      } else {
        removeItemAt(0);
      }
    }
  }

  function schedulePending(): void {
    if (pendingCount() === 0) return;
    if (collectDebugStats) schedulePasses += 1;

    const now = Date.now();
    discardExpiredPending(now);
    if (pendingCount() === 0) return;

    let currentLayout = refreshLayout();
    if (!currentLayout || viewportWidth <= 0) {
      // Until the first non-zero resize tick there is no meaningful spawn
      // position. A burst of IPC events must not redo this failed work.
      pendingBlocked = true;
      pendingRetrySeconds = Number.POSITIVE_INFINITY;
      pendingRetryOnNextTick = false;
      return;
    }

    resetPendingScheduling();
    while (pendingHead < pending.length) {
      const candidate = pending[pendingHead];
      if (candidate.fontSize > largestScrollFontSize) {
        largestScrollFontSize = candidate.fontSize;
        layoutDirty = true;
        currentLayout = refreshLayout();
        if (!currentLayout) return;
      }
      const lane = findSafeLane(candidate);
      if (lane === null) {
        // Preserving a small queue is preferable to deliberately overlapping
        // comments. Retry only when the first lane can become available, or
        // when this queue head reaches its five-second expiry.
        const untilExpiry = Math.max(
          0,
          (MAX_QUEUE_AGE_MS - (Date.now() - candidate.queuedAt)) / 1000,
        );
        pendingBlocked = true;
        pendingRetrySeconds = Math.min(pendingRetrySeconds, untilExpiry);
        pendingRetryOnNextTick = false;
        return;
      }

      pendingHead += 1;
      makeRoomForItem();
      const item: EngineTrackItem = {
        id: candidate.id,
        text: candidate.text,
        richSpans: candidate.richSpans,
        color: candidate.color,
        isSelf: candidate.isSelf,
        width: candidate.width,
        speed: candidate.speed,
        fontSize: candidate.fontSize,
        kind: "scroll",
        lane,
        x: viewportWidth + SPAWN_PADDING,
        y: laneY(lane, currentLayout),
        itemIndex: -1,
        active: true,
        aggregationKey: candidate.aggregationKey,
        aggregationBaseId: candidate.aggregationBaseId,
        aggregationReservedWidth: candidate.aggregationReservedWidth,
        aggregationBaseRichSpans: candidate.aggregationBaseRichSpans,
      };
      appendItem(item);
      replaceAggregationTarget(candidate, item);
    }
    compactPending();
  }

  function trySchedulePending(fromTick = false): void {
    if (pendingCount() === 0) return;
    if (pendingBlocked && (pendingRetrySeconds > 0 || (pendingRetryOnNextTick && !fromTick))) {
      if (collectDebugStats) scheduleSkips += 1;
      return;
    }
    schedulePending();
  }

  function enqueuePendingItem(pendingItem: PendingScroll): void {
    pending.push(pendingItem);
    if (pendingCount() <= MAX_PENDING_ITEMS) return;

    // Drop the oldest waiting comment under sustained overload. The head
    // changed, so defer one fresh collision check to the next render tick
    // instead of repeating it for every event in this burst.
    forgetAggregationTarget(pending[pendingHead]);
    pendingHead += 1;
    compactPending();
    pendingBlocked = true;
    pendingRetrySeconds = 0;
    pendingRetryOnNextTick = true;
  }

  function enqueue(ev: DanmakuEvent, alreadyVisible: boolean): boolean {
    // Simple Live canvas style: content-only floating text; skip system.
    if (!alreadyVisible && !shouldShowOnCanvas(ev)) return false;

    const baseText = floatingDanmakuText(ev);
    if (!baseText) return false;

    let aggregation = contentAggregator.aggregate(ev);
    const existingAggregationTarget = aggregation.key
      ? aggregationTargets.get(aggregation.key)
      : undefined;
    if (existingAggregationTarget?.active && aggregation.count > 1) {
      updateAggregatedTarget(existingAggregationTarget, baseText, aggregation.count);
      resetPendingScheduling();
      return true;
    }

    // A target can age out of the bounded render/pending queues before the
    // content-key cache does. Start a visible count from one in that case.
    if (aggregation.key && aggregation.count > 1) {
      contentAggregator.forget(aggregation.key);
      aggregation = contentAggregator.aggregate(ev);
    }

    const isTop = ev.kind === "super_chat";
    const text = aggregatedText(baseText, aggregation.count);
    const itemFontSize = fontSize;
    const id = `${isTop ? "t" : "s"}-${++sequence}-${ev.ts}`;
    const isSelf = ev.is_self === true;
    const color = isSelf ? currentSelfColor : ev.color || (isTop ? "#ffb020" : "#ffffff");
    const baseRichSpans = floatingRichSpans(ev);
    const richSpans = richSpansWithAggregateSuffix(baseRichSpans, aggregation.count);
    const aggregationReservedWidth = aggregation.key
      ? measureTrackWidth(
          aggregatedText(baseText, MAX_AGGREGATED_DISPLAY_COUNT + 1),
          richSpansWithAggregateSuffix(baseRichSpans, MAX_AGGREGATED_DISPLAY_COUNT + 1),
          itemFontSize,
        )
      : undefined;
    const width = aggregationReservedWidth ?? measureTrackWidth(text, richSpans, itemFontSize);
    const speed = speedPx(logicalSpeed, itemFontSize);

    if (isTop) {
      makeRoomForItem();
      appendItem({
        id,
        text,
        richSpans,
        color,
        isSelf,
        width,
        speed,
        fontSize: itemFontSize,
        y: Math.max(TOP_PADDING, Math.round(itemFontSize * 0.5)),
        x: 0, // centered by the canvas renderer
        kind: "top",
        expireAt: Date.now() + TOP_DURATION_MS,
        itemIndex: -1,
        active: true,
      });
      return true;
    }

    const pendingItem: PendingScroll = {
      id,
      text,
      richSpans,
      color,
      isSelf,
      width,
      speed,
      fontSize: itemFontSize,
      queuedAt: Date.now(),
      active: true,
      aggregationKey: aggregation.key ?? undefined,
      aggregationBaseId: aggregation.key ? id : undefined,
      aggregationReservedWidth,
      aggregationBaseRichSpans: aggregation.key ? baseRichSpans : undefined,
    };
    if (aggregation.key) aggregationTargets.set(aggregation.key, pendingItem);
    enqueuePendingItem(pendingItem);
    return true;
  }

  function push(ev: DanmakuEvent, alreadyVisible = false): void {
    if (enqueue(ev, alreadyVisible)) trySchedulePending();
  }

  function pushBatch(events: readonly DanmakuEvent[], alreadyVisible = false): void {
    let enqueued = false;
    for (const event of events) {
      if (enqueue(event, alreadyVisible)) enqueued = true;
    }
    // Native transport emits at a bounded cadence. Scheduling once per batch
    // avoids repeating lane scans for the other events in the same delivery.
    if (!enqueued) return;
    // If overload replaced the queue head while this batch was being ingested,
    // run exactly one fresh pass now. The single-message path still defers to
    // the next animation tick so an IPC burst cannot create N retry scans.
    if (pendingRetryOnNextTick) resetPendingScheduling();
    trySchedulePending();
  }

  function tick(dt: number, width: number, height: number): void {
    let viewportChanged = false;
    if (Number.isFinite(width) && width > 0 && viewportWidth !== width) {
      const previousWidth = viewportWidth;
      viewportWidth = width;
      viewportChanged = true;
      if (previousWidth > 0) {
        for (const item of items) {
          if (item.kind !== "scroll") continue;
          item.x = remapScrollXForViewportWidth(item, previousWidth, width);
        }
      }
    }
    if (Number.isFinite(height) && height > 0 && viewportHeight !== height) {
      viewportHeight = height;
      layoutDirty = true;
      viewportChanged = true;
    }
    if (viewportChanged) resetPendingScheduling();

    refreshLayout();
    const now = Date.now();
    const elapsedSeconds = Math.max(0, Math.min(0.2, dt));
    if (pendingBlocked && Number.isFinite(pendingRetrySeconds)) {
      pendingRetrySeconds = Math.max(0, pendingRetrySeconds - elapsedSeconds);
    }
    if (pendingRetryOnNextTick) pendingRetryOnNextTick = false;

    let nextLength = 0;
    let removedScrollItem = false;
    for (const item of items) {
      if (item.kind === "top") {
        if (item.expireAt && item.expireAt <= now) {
          forgetAggregationTarget(item);
          noteRemovedItem(item);
          continue;
        }
        items[nextLength] = item;
        item.itemIndex = nextLength;
        nextLength += 1;
        continue;
      }

      item.x -= item.speed * elapsedSeconds;
      if (item.x + item.width < -20) {
        forgetAggregationTarget(item);
        removeFromLane(item);
        noteRemovedItem(item);
        removedScrollItem = true;
        continue;
      }
      items[nextLength] = item;
      item.itemIndex = nextLength;
      nextLength += 1;
    }
    items.length = nextLength;
    if (scrollItems.length > MAX_ITEMS * 3) compactScrollItems(true);
    if (removedScrollItem) resetPendingScheduling();
    trySchedulePending(true);
  }

  return {
    push,
    pushBatch,
    tick,
    visibleItems: () => items,
    hasWork: () => items.length > 0 || pendingCount() > 0,
    setOpts: (nextOpts) => {
      const nextFontSize = clampFontSize(nextOpts.fontSize);
      const nextScrollArea = clampArea(nextOpts.area);
      const nextLineCount = clampLineCount(nextOpts.lineCount);
      const nextAggregateRepeats = nextOpts.aggregateRepeats ?? aggregateRepeats;
      const nextAggregateWindowMs =
        nextOpts.aggregateWindowMs === undefined
          ? aggregateWindowMs
          : clampAggregateWindowMs(nextOpts.aggregateWindowMs);
      const nextSelfColor = selfDanmakuColor(nextOpts.selfColor ?? currentSelfColor);
      if (
        nextFontSize !== fontSize ||
        nextScrollArea !== scrollArea ||
        nextLineCount !== maxLineCount
      ) {
        // `fontSize` also affects the layout while there are no items. When
        // existing items remain, recompute their maximum only on this rare
        // settings change rather than once per frame.
        largestScrollFontSizeNeedsRefresh = true;
        layoutDirty = true;
        resetPendingScheduling();
      }
      fontSize = nextFontSize;
      logicalSpeed = nextOpts.speed;
      currentOpacity = clampOpacity(nextOpts.opacity);
      scrollArea = nextScrollArea;
      maxLineCount = nextLineCount;
      currentFontWeight = clampFontWeight(nextOpts.fontWeight);
      if (nextSelfColor !== currentSelfColor) {
        currentSelfColor = nextSelfColor;
        for (const item of items) {
          if (item.isSelf) item.color = currentSelfColor;
        }
        for (const item of pending) {
          if (item.isSelf) item.color = currentSelfColor;
        }
      }
      if (
        nextAggregateRepeats !== aggregateRepeats ||
        nextAggregateWindowMs !== aggregateWindowMs
      ) {
        aggregateRepeats = nextAggregateRepeats;
        aggregateWindowMs = nextAggregateWindowMs;
        contentAggregator = createDanmakuContentAggregator(aggregateRepeats, aggregateWindowMs);
        aggregationTargets.clear();
      }
    },
    opacity: () => currentOpacity,
    fontWeight: () => currentFontWeight,
    debugStats: () => ({
      schedulePasses,
      scheduleSkips,
      laneChecks,
      laneItemChecks,
      activeItems: items.length,
      pendingItems: pendingCount(),
    }),
  };
}
