import type { DanmakuEvent } from "@/shared/types/live";

export type TrackItem = {
  id: string;
  text: string;
  color: string;
  y: number;
  x: number;
  width: number;
  speed: number; // px/sec
  kind: "scroll" | "top";
  /** top items expire after this timestamp (ms) */
  expireAt?: number;
};

export type DanmakuEngine = {
  push: (ev: DanmakuEvent) => void;
  tick: (dt: number, width: number, height: number) => void;
  visibleItems: () => TrackItem[];
  setOpts: (opts: { fontSize: number; speed: number; opacity: number }) => void;
  opacity: () => number;
};

const MAX_ITEMS = 80;
const TOP_DURATION_MS = 3000;

function measureWidth(text: string, fontSize: number): number {
  // Approximate CJK-friendly width without canvas context.
  let w = 0;
  for (const ch of text) {
    w += ch.charCodeAt(0) > 255 ? fontSize : fontSize * 0.55;
  }
  return Math.max(fontSize, w + 8);
}

function speedPx(logical: number, fontSize: number): number {
  // logical 1–10 → ~80–220 px/s
  const s = Math.max(1, Math.min(10, logical || 8));
  return 60 + s * 16 + fontSize * 0.5;
}

export function createEngine(opts: {
  fontSize: number;
  speed: number;
  opacity: number;
}): DanmakuEngine {
  let fontSize = opts.fontSize;
  let logicalSpeed = opts.speed;
  let opacity = opts.opacity;
  let items: TrackItem[] = [];
  let seq = 0;
  let lastH = 720;

  function laneHeight(): number {
    return Math.max(fontSize + 8, 24);
  }

  function findLane(width: number): number {
    const lh = laneHeight();
    const maxLanes = Math.max(1, Math.floor((lastH * 0.75) / lh));
    const occupied = new Array<number>(maxLanes).fill(-Infinity);

    for (const it of items) {
      if (it.kind !== "scroll") continue;
      const lane = Math.round(it.y / lh);
      if (lane < 0 || lane >= maxLanes) continue;
      // Right edge of this item
      const right = it.x + it.width;
      occupied[lane] = Math.max(occupied[lane], right);
    }

    for (let lane = 0; lane < maxLanes; lane++) {
      // Free if last item's right edge is left of spawn with gap
      if (occupied[lane] < width - 40) {
        return lane * lh + fontSize;
      }
    }
    // All busy: pick lane with smallest right edge
    let best = 0;
    let bestRight = Infinity;
    for (let lane = 0; lane < maxLanes; lane++) {
      if (occupied[lane] < bestRight) {
        bestRight = occupied[lane];
        best = lane;
      }
    }
    return best * lh + fontSize;
  }

  function push(ev: DanmakuEvent) {
    if (ev.kind === "system") return;
    const content = (ev.content || "").trim();
    if (!content) return;

    const isTop = ev.kind === "super_chat";
    const text =
      ev.kind === "gift" || ev.kind === "enter"
        ? content
        : `${ev.user}: ${content}`;
    const color = ev.color || (isTop ? "#ffb020" : "#ffffff");
    const w = measureWidth(text, fontSize);
    const sp = speedPx(logicalSpeed, fontSize);

    // Drop oldest scroll when over cap
    while (items.length >= MAX_ITEMS) {
      const idx = items.findIndex((i) => i.kind === "scroll");
      if (idx >= 0) items.splice(idx, 1);
      else {
        items.shift();
        break;
      }
    }

    if (isTop) {
      items.push({
        id: `t-${++seq}-${ev.ts}`,
        text,
        color,
        y: fontSize + 12,
        x: 0, // centered on draw
        width: w,
        speed: 0,
        kind: "top",
        expireAt: Date.now() + TOP_DURATION_MS,
      });
      return;
    }

    const y = findLane(1280);
    items.push({
      id: `s-${++seq}-${ev.ts}`,
      text,
      color,
      y,
      x: 1280, // will be corrected on first tick with real width
      width: w,
      speed: sp,
      kind: "scroll",
    });
  }

  function tick(dt: number, width: number, height: number) {
    lastH = height || lastH;
    const now = Date.now();
    const next: TrackItem[] = [];
    for (const it of items) {
      if (it.kind === "top") {
        if (it.expireAt && it.expireAt <= now) continue;
        next.push(it);
        continue;
      }
      // Spawn correction: if still at default far right, pin to width
      let x = it.x;
      if (x > width + 10) x = width + 8;
      x -= it.speed * dt;
      if (x + it.width < -20) continue;
      next.push({ ...it, x });
    }
    items = next;
  }

  return {
    push,
    tick,
    visibleItems: () => items.slice(),
    setOpts: (o) => {
      fontSize = o.fontSize;
      logicalSpeed = o.speed;
      opacity = o.opacity;
    },
    opacity: () => opacity,
  };
}
