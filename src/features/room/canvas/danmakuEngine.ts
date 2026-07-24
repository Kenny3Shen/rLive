import type { DanmakuEvent } from "@/shared/types/live";
import { floatingDanmakuText, shouldShowOnCanvas } from "../danmaku/filter";

export type TrackItem = {
  id: string;
  text: string;
  color: string;
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
  push: (ev: DanmakuEvent) => void;
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
};

type PendingScroll = Omit<TrackItem, "kind" | "lane" | "x" | "y"> & {
  queuedAt: number;
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

function measureWidth(text: string, fontSize: number): number {
  // Approximate CJK-friendly width without a canvas context.
  let width = 0;
  for (const char of text) {
    width += char.charCodeAt(0) > 255 ? fontSize : fontSize * 0.55;
  }
  return Math.max(fontSize, width + 8);
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

/** First-fit order from the top edge down, matching Simple Live's tracks. */
function createTopDownLaneOrder(count: number): number[] {
  return Array.from({ length: count }, (_, lane) => lane);
}

function layoutFor(height: number, fontSize: number, area: number, lineCount: number): LaneLayout {
  const safeHeight = Math.max(1, Math.floor(height));
  const laneHeight = Math.max(fontSize + 9, 24);
  const preferredArea = Math.max(laneHeight, Math.floor(safeHeight * area));
  const autoCount = Math.max(1, Math.floor(preferredArea / laneHeight));
  const count = lineCount > 0 ? Math.min(lineCount, autoCount) : autoCount;
  return {
    count,
    laneHeight,
    top: 0,
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

export function createEngine(opts: DanmakuEngineOptions): DanmakuEngine {
  let fontSize = clampFontSize(opts.fontSize);
  let logicalSpeed = opts.speed;
  let currentOpacity = clampOpacity(opts.opacity);
  let scrollArea = clampArea(opts.area);
  let maxLineCount = clampLineCount(opts.lineCount);
  let currentFontWeight = clampFontWeight(opts.fontWeight);
  let items: TrackItem[] = [];
  let pending: PendingScroll[] = [];
  let sequence = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let layout: LaneLayout | null = null;
  let laneOrder: number[] = [];
  let laneCursor = 0;

  function largestActiveScrollFontSize(): number {
    let largest = fontSize;
    for (const item of items) {
      if (item.kind === "scroll" && item.fontSize > largest) {
        largest = item.fontSize;
      }
    }
    return largest;
  }

  function refreshLayout(): LaneLayout | null {
    if (viewportHeight <= 0) return null;

    // Existing messages retain the size they had at insertion. Keep enough
    // vertical room for them while a setting change is still on screen.
    const nextLayout = layoutFor(
      viewportHeight,
      largestActiveScrollFontSize(),
      scrollArea,
      maxLineCount,
    );
    if (sameLayout(layout, nextLayout)) return layout;

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
    laneCursor %= laneOrder.length;
    return layout;
  }

  function minTailGap(candidate: PendingScroll): number {
    return Math.max(24, Math.round(candidate.fontSize * 1.4));
  }

  /**
   * A lane is safe when a new message will not get closer than `minTailGap`
   * before every leading item has left the visible area. This is the common
   * time-to-catch-up check used by scrolling-danmaku renderers.
   */
  function isLaneSafe(lane: number, candidate: PendingScroll): boolean {
    const spawnX = viewportWidth + SPAWN_PADDING;
    const gap = minTailGap(candidate);

    for (const item of items) {
      if (item.kind !== "scroll" || item.lane !== lane) continue;

      const leadingRight = item.x + item.width;
      if (leadingRight <= 0) continue;

      const initialDistance = spawnX - leadingRight;
      if (initialDistance < gap) return false;

      const closingSpeed = candidate.speed - item.speed;
      if (closingSpeed <= 0) continue;

      const timeUntilGap = (initialDistance - gap) / closingSpeed;
      const timeUntilLeadingItemLeaves = leadingRight / item.speed;
      if (timeUntilGap < timeUntilLeadingItemLeaves) return false;
    }
    return true;
  }

  function findSafeLane(candidate: PendingScroll): number | null {
    for (let offset = 0; offset < laneOrder.length; offset += 1) {
      const orderIndex = (laneCursor + offset) % laneOrder.length;
      const lane = laneOrder[orderIndex];
      if (isLaneSafe(lane, candidate)) {
        laneCursor = (orderIndex + 1) % laneOrder.length;
        return lane;
      }
    }

    return null;
  }

  function makeRoomForItem(): void {
    while (items.length >= MAX_ITEMS) {
      const scrollIndex = items.findIndex((item) => item.kind === "scroll");
      if (scrollIndex >= 0) {
        items.splice(scrollIndex, 1);
      } else {
        items.shift();
      }
    }
  }

  function schedulePending(): void {
    const currentLayout = refreshLayout();
    if (!currentLayout || viewportWidth <= 0) return;

    const now = Date.now();
    let firstFreshIndex = 0;
    while (
      firstFreshIndex < pending.length &&
      now - pending[firstFreshIndex].queuedAt > MAX_QUEUE_AGE_MS
    ) {
      firstFreshIndex += 1;
    }
    if (firstFreshIndex > 0) pending.splice(0, firstFreshIndex);

    while (pending.length > 0) {
      const candidate = pending[0];
      const lane = findSafeLane(candidate);
      if (lane === null) {
        // Preserving a small queue is preferable to deliberately overlapping
        // comments. Stale entries are discarded above to keep the feed live.
        break;
      }

      pending.shift();
      makeRoomForItem();
      items.push({
        ...candidate,
        kind: "scroll",
        lane,
        x: viewportWidth + SPAWN_PADDING,
        y: laneY(lane, currentLayout),
      });
    }
  }

  function push(ev: DanmakuEvent): void {
    // Simple Live canvas style: content-only floating text; skip system.
    if (!shouldShowOnCanvas(ev)) return;

    const text = floatingDanmakuText(ev);
    if (!text) return;

    const isTop = ev.kind === "super_chat";
    const itemFontSize = fontSize;
    const item = {
      id: `${isTop ? "t" : "s"}-${++sequence}-${ev.ts}`,
      text,
      color: ev.color || (isTop ? "#ffb020" : "#ffffff"),
      width: measureWidth(text, itemFontSize),
      speed: speedPx(logicalSpeed, itemFontSize),
      fontSize: itemFontSize,
    };

    if (isTop) {
      makeRoomForItem();
      items.push({
        ...item,
        y: Math.max(8, Math.round(itemFontSize * 0.5)),
        x: 0, // centered by the canvas renderer
        kind: "top",
        expireAt: Date.now() + TOP_DURATION_MS,
      });
      return;
    }

    pending.push({ ...item, queuedAt: Date.now() });
    if (pending.length > MAX_PENDING_ITEMS) pending.shift();
    schedulePending();
  }

  function tick(dt: number, width: number, height: number): void {
    if (Number.isFinite(width) && width > 0) viewportWidth = width;
    if (Number.isFinite(height) && height > 0) viewportHeight = height;

    refreshLayout();
    const now = Date.now();
    const elapsedSeconds = Math.max(0, Math.min(0.2, dt));
    let nextLength = 0;
    for (const item of items) {
      if (item.kind === "top") {
        if (item.expireAt && item.expireAt <= now) continue;
        items[nextLength] = item;
        nextLength += 1;
        continue;
      }

      item.x -= item.speed * elapsedSeconds;
      if (item.x + item.width < -20) continue;
      items[nextLength] = item;
      nextLength += 1;
    }
    items.length = nextLength;
    schedulePending();
  }

  return {
    push,
    tick,
    visibleItems: () => items,
    hasWork: () => items.length > 0 || pending.length > 0,
    setOpts: (nextOpts) => {
      fontSize = clampFontSize(nextOpts.fontSize);
      logicalSpeed = nextOpts.speed;
      currentOpacity = clampOpacity(nextOpts.opacity);
      scrollArea = clampArea(nextOpts.area);
      maxLineCount = clampLineCount(nextOpts.lineCount);
      currentFontWeight = clampFontWeight(nextOpts.fontWeight);
    },
    opacity: () => currentOpacity,
    fontWeight: () => currentFontWeight,
  };
}
