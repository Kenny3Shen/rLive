import type { DanmuJsComment, DanmuJsMode } from "danmu.js";
import {
  DANMU_JS_DEFAULT_DURATION_MS,
  DANMU_JS_DEFAULT_MOVE_V,
  DANMU_JS_FONT_WEIGHT,
  clampDanmuFontSize,
  clampDanmuOpacity,
} from "@/features/room/danmaku/danmuJsAdapter";
import type { VideoDanmakuItem } from "@/shared/types/video";

/**
 * VOD 弹幕的分段与调度。
 *
 * 与直播的唯一区别是**调度源**：直播是 WebSocket 到达即投放，VOD 必须按
 * `player.currentTime` 投放。渲染层（danmu.js、字号/透明度/区域/速度设置、屏蔽词）
 * 继续复用 `features/room/danmaku/` 那一套，这里只产出「什么时候该发哪一条」。
 */

/** 上游按 6 分钟切段，段号从 1 起。 */
export const VIDEO_DANMAKU_SEGMENT_MS = 360_000;

export function videoDanmakuSegmentIndex(positionMs: number): number {
  const position = Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0;
  return Math.floor(position / VIDEO_DANMAKU_SEGMENT_MS) + 1;
}

/**
 * 该播放位置需要保证已加载的段号集合。
 *
 * 除当前段外多取一段：滚动弹幕在自己出现时间之前就要开始入场，正好跨段的那几条
 * 若等到播放头进入下一段才请求，会迟到整条弹幕的行程时间。只预取一段而不是更多，
 * 是因为一次请求就够盖住 6 分钟。
 */
export function videoDanmakuSegmentsFor(positionMs: number): number[] {
  const index = videoDanmakuSegmentIndex(positionMs);
  return [index, index + 1];
}

/**
 * 弹幕模式映射。
 *
 * 上游 1/2/3 都是滚动，4 底部居中，5 顶部居中。6（逆向）、7（高级）、8（代码）、
 * 9（BAS）没有对应的 danmu.js 形态，按滚动降级 —— 它们在存量弹幕里占比极低，
 * 丢弃反而会让画面莫名变空。
 */
export function videoDanmakuMode(mode: number): DanmuJsMode {
  if (mode === 4) return "bottom";
  if (mode === 5) return "top";
  return "scroll";
}

/**
 * RGB 十进制转 `#rrggbb`。
 *
 * 上游给的是十进制整数（如 16777215 = 白）。越界值回落白色而不是让非法颜色进内联
 * 样式 —— `safeDanmuColor` 那道校验只认得字符串形态，这里必须先转对。
 */
export function videoDanmakuColor(color: number): string {
  if (!Number.isFinite(color)) return "#ffffff";
  const value = Math.trunc(color);
  if (value <= 0 || value > 0xffffff) return "#ffffff";
  return `#${value.toString(16).padStart(6, "0")}`;
}

export type VideoDanmakuEntry = {
  /** 段内去重后的稳定 id，投放给 danmu.js 时必须唯一。 */
  id: string;
  /** 出现时间，毫秒。 */
  progressMs: number;
  mode: DanmuJsMode;
  color: string;
  content: string;
  weight: number;
  pool: number;
};

/**
 * 把一段原始弹幕规整成可调度的条目。
 *
 * id 带上段号：同一 cid 的不同段里 `progress` 可能巧合相同，只用内容+时间做 key
 * 会让 danmu.js 因 id 冲突丢掉后来那条。
 */
export function videoDanmakuEntries(
  items: readonly VideoDanmakuItem[],
  segmentIndex: number,
): VideoDanmakuEntry[] {
  const entries: VideoDanmakuEntry[] = [];
  for (const [index, item] of items.entries()) {
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) continue;
    entries.push({
      id: `${segmentIndex}:${index}`,
      progressMs: Math.max(0, Math.trunc(item.progress)),
      mode: videoDanmakuMode(item.mode),
      color: videoDanmakuColor(item.color),
      content,
      weight: Number.isFinite(item.weight) ? item.weight : 0,
      pool: Number.isFinite(item.pool) ? item.pool : 0,
    });
  }
  return entries.sort((left, right) => left.progressMs - right.progressMs);
}

/** 合并多段并按时间排序；重复段号由调用方去重，这里只负责有序合并。 */
export function mergeVideoDanmakuEntries(
  segments: readonly (readonly VideoDanmakuEntry[])[],
): VideoDanmakuEntry[] {
  return segments.flat().sort((left, right) => left.progressMs - right.progressMs);
}

export type VideoDanmakuFilterOptions = {
  /** 屏蔽词，与直播共用设置。 */
  isShielded: (content: string) => boolean;
  /**
   * 权重下限。上游 `weight` 是平台给的屏蔽等级（1..10，越低越可能是垃圾），
   * 0 表示不按等级过滤。
   */
  minWeight: number;
  /** 是否显示字幕池（pool 1）与特殊池（pool 2）弹幕。 */
  showSubtitlePool: boolean;
};

export function filterVideoDanmakuEntries(
  entries: readonly VideoDanmakuEntry[],
  options: VideoDanmakuFilterOptions,
): VideoDanmakuEntry[] {
  return entries.filter((entry) => {
    if (options.minWeight > 0 && entry.weight > 0 && entry.weight < options.minWeight) return false;
    if (!options.showSubtitlePool && entry.pool !== 0) return false;
    return !options.isShielded(entry.content);
  });
}

/** 二分找出第一条 `progressMs >= positionMs` 的条目下标。 */
export function firstVideoDanmakuAtOrAfter(
  entries: readonly VideoDanmakuEntry[],
  positionMs: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle]!.progressMs < positionMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * 单帧最多投放的弹幕数。
 *
 * 高能片段一秒内可能挤进上百条，一次全投会让 danmu.js 在同一帧构建上百个 DOM 节点、
 * 掉一整帧；而车道本来也装不下那么多，多出来的会被它直接丢弃。分帧投放让密集段落
 * 平滑铺开，视觉上与上游播放器一致。
 */
export const VIDEO_DANMAKU_MAX_PER_TICK = 24;

/**
 * 一次调度要投放的条目。
 *
 * `cursor` 是「已投放到哪个下标」的游标，seek 后由调用方用
 * `firstVideoDanmakuAtOrAfter` 重置。刻意不在这里保存状态：seek 的正确性依赖游标
 * 能被外部无条件重置，藏在闭包里反而更容易漏掉那一步。
 */
export function nextVideoDanmakuBatch(
  entries: readonly VideoDanmakuEntry[],
  cursor: number,
  positionMs: number,
  maxPerTick = VIDEO_DANMAKU_MAX_PER_TICK,
): { batch: VideoDanmakuEntry[]; cursor: number } {
  const batch: VideoDanmakuEntry[] = [];
  let index = Math.max(0, cursor);
  while (index < entries.length && entries[index]!.progressMs <= positionMs) {
    if (batch.length >= maxPerTick) {
      // 超预算的条目直接跳过而不是留到下一帧：它们的出现时间已经过去，
      // 补投会让弹幕成片迟到、与画面错位。
      index += 1;
      continue;
    }
    batch.push(entries[index]!);
    index += 1;
  }
  return { batch, cursor: index };
}

/**
 * 把条目映射成 danmu.js 评论。
 *
 * `realTime: true` + 不带 `start`：调度由我们按 `currentTime` 完成，交给 danmu.js
 * 自己的时间轴会让它同时按 `start` 再排一次，seek 后两套时间轴必然打架。
 */
export function videoDanmakuComment(
  entry: VideoDanmakuEntry,
  options: { fontSize: number; fontStroke: number; opacity: number; moveV: number },
): DanmuJsComment {
  const fontSize = clampDanmuFontSize(options.fontSize);
  const opacity = clampDanmuOpacity(options.opacity);
  const style: Record<string, string | number> = {
    color: entry.color,
    opacity: String(opacity),
    fontSize: `${fontSize}px`,
    fontWeight: DANMU_JS_FONT_WEIGHT,
    lineHeight: "1.35",
    whiteSpace: "nowrap",
    textShadow: "0 1px 2px rgba(0,0,0,.92), 0 0 3px rgba(0,0,0,.72)",
    pointerEvents: "none",
  };
  if (options.fontStroke > 0) {
    // 大写 W 是必须的：danmu.js 自己把 camelCase 键转成 CSS 文本，小写会生成
    // 非法的无前缀 `webkit-text-stroke`。
    style.WebkitTextStroke = `${options.fontStroke}px rgba(0,0,0,.92)`;
    style.paintOrder = "stroke fill";
  }

  return {
    id: entry.id,
    txt: entry.content,
    mode: entry.mode,
    realTime: true,
    color: true,
    elLazyInit: true,
    disableCopyDOM: true,
    // 固定模式没有行程，只能按时长消失；滚动模式交给 moveV 以保持恒定速度
    // （长短弹幕同速，与设置里的「弹幕速度」是同一个 px/s 语义）。
    ...(entry.mode === "scroll"
      ? { moveV: options.moveV > 0 ? options.moveV : DANMU_JS_DEFAULT_MOVE_V }
      : { duration: DANMU_JS_DEFAULT_DURATION_MS }),
    style,
  };
}
