import {
  aggregatedDanmakuText,
  danmakuContentAggregationKey,
} from "@/features/room/danmaku/filter";
import type { RecordedDanmakuEntry } from "./recordedDanmaku";

/**
 * Lane assignment for recorded playback.
 *
 * Recorded danmaku is laid out ahead of time instead of per frame: media time
 * can jump in either direction, so a lane may only be chosen from data that is
 * independent of the current position. The occupancy rule mirrors the ASS
 * exporter (`recording_ass.rs`, after DanmakuFactory): a lane accepts the next
 * bullet once the previous one has left a safety gap behind its tail and, at the
 * moment the newcomer's head reaches that gap, has already left the stage.
 */

export type RecordedDanmakuLayoutOptions = {
  laneCount: number;
  stageWidth: number;
  /** Horizontal slack outside both stage edges, matching the canvas painter. */
  padding: number;
  /** Minimum horizontal distance kept between neighbours on one lane. */
  laneGap: number;
  /**
   * Rendered width of a bullet, stroke expansion included. `entry` and `count`
   * are passed alongside the aggregated text because a bullet carrying image
   * emotes is not measurable from its text alone.
   */
  measure: (text: string, entry: RecordedDanmakuEntry, count: number) => number;
  /** Lifetime of a bullet with the given rendered width. */
  lifetimeFor: (width: number) => number;
  /** Reduced motion pins bullets in place, so a lane is exclusive end to end. */
  staticLayout: boolean;
  mergeWindowMs: number;
  /**
   * Longest span one merge group may cover. Capping it to the visible lifetime
   * keeps a duplicate from being folded into an anchor that already scrolled
   * off screen, which would drop it from view entirely.
   */
  maxGroupSpanMs: number;
};

export type RecordedDanmakuPlacement = {
  entry: RecordedDanmakuEntry;
  lane: number;
  startMs: number;
  endMs: number;
  lifetimeMs: number;
  /** Width reserved for the largest count this group can reach. */
  width: number;
  baseText: string;
  /** Offsets of every message folded into this bullet, ascending. */
  memberOffsets: number[];
};

export type RecordedDanmakuLayout = {
  /** Ascending by `startMs`; entries no lane could hold are absent. */
  placements: RecordedDanmakuPlacement[];
  /** Longest lifetime in the layout, used as the visibility lookback. */
  maxLifetimeMs: number;
};

export type RecordedDanmakuBullet = {
  placement: RecordedDanmakuPlacement;
  text: string;
  /** Messages folded into this bullet that already happened, at least 1. */
  count: number;
  /** Fraction of the lifetime already elapsed, 0 ..= 1. */
  progress: number;
  ageMs: number;
};

type MergeGroup = {
  entry: RecordedDanmakuEntry;
  baseText: string;
  memberOffsets: number[];
  lastOffsetMs: number;
};

type Lane = {
  /** Earliest start that keeps a safety gap behind the previous tail. */
  freeFrom: number;
  /** When the previous bullet fully left the stage. */
  leftAt: number;
};

/**
 * Fold duplicate chat into anchors without deciding any count: the anchor keeps
 * every member offset so the painter can count only what already happened.
 */
function groupDuplicates(
  entries: readonly RecordedDanmakuEntry[],
  mergeWindowMs: number,
  maxGroupSpanMs: number,
): MergeGroup[] {
  const groups: MergeGroup[] = [];
  const open = new Map<string, number>();
  const merging = mergeWindowMs > 0;

  for (const entry of entries) {
    const key = merging ? danmakuContentAggregationKey(entry.event) : null;
    const openIndex = key === null ? undefined : open.get(key);
    const group = openIndex === undefined ? undefined : groups[openIndex];
    if (
      group &&
      entry.offsetMs >= group.lastOffsetMs &&
      entry.offsetMs - group.lastOffsetMs <= mergeWindowMs &&
      entry.offsetMs - group.entry.offsetMs <= maxGroupSpanMs
    ) {
      group.memberOffsets.push(entry.offsetMs);
      group.lastOffsetMs = entry.offsetMs;
      continue;
    }
    if (key !== null) open.set(key, groups.length);
    groups.push({
      entry,
      baseText: entry.text,
      memberOffsets: [entry.offsetMs],
      lastOffsetMs: entry.offsetMs,
    });
  }

  return groups;
}

/**
 * Longest shift the `delay` fallback may apply. Recorded playback is offline, so
 * a bounded shift is preferable to overlapping text, but a bullet that drifts
 * further than this no longer belongs to what is on screen.
 */
export const RECORDED_DANMAKU_MAX_DELAY_MS = 5_000;

/**
 * Assign lanes for the whole recording once. Bullets no lane can hold within the
 * delay budget are dropped, which is what keeps dense traffic readable instead of
 * stacking text on top of itself.
 */
export function layoutRecordedDanmaku(
  entries: readonly RecordedDanmakuEntry[],
  options: RecordedDanmakuLayoutOptions,
): RecordedDanmakuLayout {
  const laneCount = Math.max(1, Math.floor(options.laneCount));
  const stageWidth = Math.max(1, options.stageWidth);
  const padding = Math.max(0, options.padding);
  const laneGap = Math.max(0, Math.min(stageWidth / 2, options.laneGap));
  const lanes: Lane[] = Array.from({ length: laneCount }, () => ({
    freeFrom: Number.NEGATIVE_INFINITY,
    leftAt: Number.NEGATIVE_INFINITY,
  }));
  const placements: RecordedDanmakuPlacement[] = [];
  let maxLifetimeMs = 0;

  const groups = groupDuplicates(entries, options.mergeWindowMs, options.maxGroupSpanMs);
  for (const group of groups) {
    // Reserve room for the largest count this group can reach so a growing
    // counter never widens a bullet past the gap its lane was granted.
    const maxCount = group.memberOffsets.length;
    const width = Math.max(
      1,
      options.measure(aggregatedDanmakuText(group.baseText, maxCount), group.entry, maxCount),
    );
    const lifetimeMs = Math.max(1, options.lifetimeFor(width));
    const travel = stageWidth + width + padding * 2;
    const reachGapMs = options.staticLayout
      ? 0
      : (lifetimeMs * Math.max(0, stageWidth - laneGap)) / travel;
    const freeAfterMs = options.staticLayout
      ? lifetimeMs
      : (lifetimeMs * (width + padding * 2 + laneGap)) / travel;

    const earliest = (lane: Lane) => Math.max(lane.freeFrom, lane.leftAt - reachGapMs);
    let lane = -1;
    let startMs = group.entry.offsetMs;
    for (let index = 0; index < lanes.length; index += 1) {
      if (startMs >= earliest(lanes[index]!)) {
        lane = index;
        break;
      }
    }
    if (lane < 0) {
      // Every lane is busy: take the one that frees up first, as long as the
      // shift stays inside the budget.
      let bestStart = Number.POSITIVE_INFINITY;
      for (let index = 0; index < lanes.length; index += 1) {
        const candidate = earliest(lanes[index]!);
        if (candidate < bestStart) {
          bestStart = candidate;
          lane = index;
        }
      }
      if (lane < 0 || bestStart - group.entry.offsetMs > RECORDED_DANMAKU_MAX_DELAY_MS) continue;
      startMs = bestStart;
    }

    lanes[lane] = { freeFrom: startMs + freeAfterMs, leftAt: startMs + lifetimeMs };
    placements.push({
      entry: group.entry,
      lane,
      startMs,
      endMs: startMs + lifetimeMs,
      lifetimeMs,
      width,
      baseText: group.baseText,
      memberOffsets: group.memberOffsets,
    });
    if (lifetimeMs > maxLifetimeMs) maxLifetimeMs = lifetimeMs;
  }

  // The delay fallback shifts starts, so restore ascending order for the
  // windowed lookup below. Equal starts keep their lane order, top to bottom.
  placements.sort((left, right) => left.startMs - right.startMs || left.lane - right.lane);
  return { placements, maxLifetimeMs };
}

function firstPlacementStartingAtOrAfter(
  placements: readonly RecordedDanmakuPlacement[],
  startMs: number,
): number {
  let low = 0;
  let high = placements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (placements[middle]!.startMs < startMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Bullets alive at `currentMs`. Repeat counts include only the messages that
 * already happened, so seeking backwards never reveals a future count.
 */
export function visibleRecordedDanmaku(
  layout: RecordedDanmakuLayout,
  currentMs: number,
): RecordedDanmakuBullet[] {
  const current = Number.isFinite(currentMs) ? Math.max(0, currentMs) : 0;
  const { placements } = layout;
  const first = firstPlacementStartingAtOrAfter(placements, current - layout.maxLifetimeMs);
  const last = firstPlacementStartingAtOrAfter(placements, current + 1);
  const bullets: RecordedDanmakuBullet[] = [];

  for (let index = first; index < last; index += 1) {
    const placement = placements[index]!;
    const ageMs = current - placement.startMs;
    if (ageMs < 0 || ageMs >= placement.lifetimeMs) continue;
    let happened = 0;
    for (const offsetMs of placement.memberOffsets) {
      if (offsetMs > current) break;
      happened += 1;
    }
    const count = Math.max(1, happened);
    bullets.push({
      placement,
      text: aggregatedDanmakuText(placement.baseText, count),
      count,
      progress: Math.min(1, ageMs / placement.lifetimeMs),
      ageMs,
    });
  }

  return bullets;
}
