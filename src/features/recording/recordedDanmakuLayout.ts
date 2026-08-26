import {
  aggregatedDanmakuText,
  danmakuContentAggregationKey,
} from "@/features/room/danmaku/filter";
import type { RecordedDanmakuEntry } from "./recordedDanmaku";

/**
 * 录制回放的车道分配。
 *
 * 录制弹幕提前布局而不是逐帧布局：媒体时间可能双向跳转，
 * 因此车道只能依据与当前位置无关的数据来决定。占用规则与 ASS 导出器一致
 * （`recording_ass.rs`，仿照 DanmakuFactory）：当前一条弹幕的尾部留出安全间距、
 * 并且在新来者头部抵达该间距的时刻已完全离场之后，
 * 车道才接受下一条弹幕。
 */

export type RecordedDanmakuLayoutOptions = {
  laneCount: number;
  stageWidth: number;
  /** 舞台两侧边缘之外的横向余量，与 canvas 绘制器一致。 */
  padding: number;
  /** 同一车道相邻弹幕之间保持的最小横向距离。 */
  laneGap: number;
  /**
   * 弹幕的渲染宽度，包含描边扩展。`entry` 与 `count`
   * 随聚合文本一起传入，因为携带图片表情的弹幕
   * 无法仅凭文本测量。
   */
  measure: (text: string, entry: RecordedDanmakuEntry, count: number) => number;
  /** 给定渲染宽度弹幕的存续时长。 */
  lifetimeFor: (width: number) => number;
  /** 减少动态效果时弹幕原地固定不动，车道全程独占。 */
  staticLayout: boolean;
  mergeWindowMs: number;
  /**
   * 单个合并组允许覆盖的最大跨度。把它限制在可见存续期内，
   * 避免重复消息被折叠进早已滚出屏幕的锚点而完全消失。
   */
  maxGroupSpanMs: number;
};

export type RecordedDanmakuPlacement = {
  entry: RecordedDanmakuEntry;
  lane: number;
  startMs: number;
  endMs: number;
  lifetimeMs: number;
  /** 为该组可能达到的最大计数预留的宽度。 */
  width: number;
  baseText: string;
  /** 折叠进该弹幕的所有消息偏移量，升序。 */
  memberOffsets: number[];
};

export type RecordedDanmakuLayout = {
  /** 按 `startMs` 升序；任何车道都无法容纳的条目不出现。 */
  placements: RecordedDanmakuPlacement[];
  /** 布局中最长的存续时长，用作可见性回看窗口。 */
  maxLifetimeMs: number;
};

export type RecordedDanmakuBullet = {
  placement: RecordedDanmakuPlacement;
  text: string;
  /** 已折叠进该弹幕且已经发生的消息数，至少为 1。 */
  count: number;
  /** 已过去的存续时长比例，0 ..= 1。 */
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
  /** 能在前一条尾部之后保留安全间距的最早开始时间。 */
  freeFrom: number;
  /** 前一条弹幕完全离开舞台的时刻。 */
  leftAt: number;
};

/**
 * 把重复聊天折叠进锚点但不预先决定任何计数：锚点保留每个成员的偏移量，
 * 由绘制器只统计已经发生的部分。
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
 * `delay` 兜底允许的最大平移。录制回放是离线的，有界的平移优于文字重叠，
 * 但漂移超过此距离的弹幕已不属于屏幕上的内容。
 */
export const RECORDED_DANMAKU_MAX_DELAY_MS = 5_000;

/**
 * 为整场录制一次性分配车道。在延迟预算内没有任何车道能容纳的弹幕会被丢弃，
 * 这正是让密集流量保持可读、而不是文字叠文字的原因。
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
    // 为该组可能达到的最大计数预留空间，
    // 使增长的计数永远不会把弹幕撑出其车道获批的间隙。
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
      // 所有车道都忙：只要平移保持在预算内，选择最早空出的那条。
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

  // 延迟兜底会平移开始时间，因此重新排成升序供下方按窗口查找。
  // 相同开始时间的保持车道顺序，自上而下。
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
 * 在 `currentMs` 时仍存活的弹幕。重复计数只包含已经发生的消息，
 * 因此向后 seek 绝不会泄露未来的计数。
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
