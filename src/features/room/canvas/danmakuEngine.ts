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
  visibleItems: () => TrackItem[];
  setOpts: (opts: { fontSize: number; speed: number; opacity: number }) => void;
  opacity: () => number;
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
const SCROLL_AREA_RATIO = 0.9;
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

/**
 * Returns a breadth-first middle-out order. Compared with scanning from lane 0,
 * the first few comments already occupy the centre and both halves of the video.
 */
function createBalancedLaneOrder(count: number): number[] {
  const order: number[] = [];
  let ranges: Array<[number, number]> = [[0, count - 1]];

  while (ranges.length > 0) {
    const next: Array<[number, number]> = [];
    for (const [start, end] of ranges) {
      if (start > end) continue;

      const middle = Math.floor((start + end) / 2);
      order.push(middle);
      next.push([start, middle - 1], [middle + 1, end]);
    }
    ranges = next;
  }

  return order;
}

function layoutFor(height: number, fontSize: number): LaneLayout {
  const safeHeight = Math.max(1, Math.floor(height));
  const laneHeight = Math.max(fontSize + 9, 24);
  const preferredArea = Math.max(laneHeight, Math.floor(safeHeight * SCROLL_AREA_RATIO));
  const count = Math.max(1, Math.floor(preferredArea / laneHeight));
  const blockHeight = Math.min(safeHeight, count * laneHeight);

  return {
    count,
    laneHeight,
    top: Math.max(0, Math.floor((safeHeight - blockHeight) / 2)),
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

export function createEngine(opts: {
  fontSize: number;
  speed: number;
  opacity: number;
}): DanmakuEngine {
  let fontSize = clampFontSize(opts.fontSize);
  let logicalSpeed = opts.speed;
  let currentOpacity = clampOpacity(opts.opacity);
  let items: TrackItem[] = [];
  let pending: PendingScroll[] = [];
  let sequence = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let layout: LaneLayout | null = null;
  let laneOrder: number[] = [];
  let laneCursor = 0;

  function largestActiveScrollFontSize(): number {
    return items.reduce(
      (largest, item) => (item.kind === "scroll" ? Math.max(largest, item.fontSize) : largest),
      fontSize,
    );
  }

  function refreshLayout(): LaneLayout | null {
    if (viewportHeight <= 0) return null;

    // Existing messages retain the size they had at insertion. Keep enough
    // vertical room for them while a setting change is still on screen.
    const nextLayout = layoutFor(viewportHeight, largestActiveScrollFontSize());
    if (sameLayout(layout, nextLayout)) return layout;

    const previousLayout = layout;
    if (previousLayout) {
      items = items.map((item) => {
        if (item.kind !== "scroll") return item;

        const oldLane = item.lane ?? 0;
        const lane = remapLane(oldLane, previousLayout.count, nextLayout.count);
        return { ...item, lane, y: laneY(lane, nextLayout) };
      });
    }

    layout = nextLayout;
    laneOrder = createBalancedLaneOrder(nextLayout.count);
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

    return !items.some((item) => {
      if (item.kind !== "scroll" || item.lane !== lane) return false;

      const leadingRight = item.x + item.width;
      if (leadingRight <= 0) return false;

      const initialDistance = spawnX - leadingRight;
      if (initialDistance < gap) return true;

      const closingSpeed = candidate.speed - item.speed;
      if (closingSpeed <= 0) return false;

      const timeUntilGap = (initialDistance - gap) / closingSpeed;
      const timeUntilLeadingItemLeaves = leadingRight / item.speed;
      return timeUntilGap < timeUntilLeadingItemLeaves;
    });
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
    pending = pending.filter((item) => now - item.queuedAt <= MAX_QUEUE_AGE_MS);

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
    const nextItems: TrackItem[] = [];

    for (const item of items) {
      if (item.kind === "top") {
        if (item.expireAt && item.expireAt <= now) continue;
        nextItems.push(item);
        continue;
      }

      const x = item.x - item.speed * elapsedSeconds;
      if (x + item.width < -20) continue;
      nextItems.push({ ...item, x });
    }

    items = nextItems;
    schedulePending();
  }

  return {
    push,
    tick,
    visibleItems: () => items.slice(),
    setOpts: (nextOpts) => {
      fontSize = clampFontSize(nextOpts.fontSize);
      logicalSpeed = nextOpts.speed;
      currentOpacity = clampOpacity(nextOpts.opacity);
    },
    opacity: () => currentOpacity,
  };
}
