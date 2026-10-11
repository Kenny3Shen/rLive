import type { DanmakuComment } from "@/features/room/danmaku/danmakuTypes";
import {
  DANMAKU_DEFAULT_DURATION_MS,
  DANMAKU_FONT_WEIGHT,
  clampDanmuFontSize,
  clampDanmuFontStroke,
  clampDanmuOpacity,
  createDanmuBulletElement,
  danmuLaneHeight,
} from "@/features/room/danmaku/danmakuAdapter";
import type { VideoDanmakuItem } from "@/shared/types/video";

/** VOD 分段、筛选与数据映射；播放调度由共享 Danmaku 渲染器的媒体绑定负责。 */
export const VIDEO_DANMAKU_SEGMENT_MS = 360_000;

export function videoDanmakuSegmentIndex(positionMs: number): number {
  const position = Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0;
  return Math.floor(position / VIDEO_DANMAKU_SEGMENT_MS) + 1;
}

/** 提前取下一段，避免播放头跨越六分钟边界时等待弹幕请求。 */
export function videoDanmakuSegmentsFor(positionMs: number): number[] {
  const index = videoDanmakuSegmentIndex(positionMs);
  return [index, index + 1];
}

/** 维持现有三种展示形态，高级/代码等未支持模式仍按普通滚动降级。 */
export function videoDanmakuMode(mode: number): DanmakuComment["mode"] {
  if (mode === 4) return "bottom";
  if (mode === 5) return "top";
  return "scroll";
}

/** RGB 十进制转 #rrggbb，非法颜色回落白色。 */
export function videoDanmakuColor(color: number): string {
  if (!Number.isFinite(color)) return "#ffffff";
  const value = Math.trunc(color);
  if (value <= 0 || value > 0xffffff) return "#ffffff";
  return `#${value.toString(16).padStart(6, "0")}`;
}

export type VideoDanmakuEntry = {
  /** 段内稳定 id，跨段不能冲突。 */
  id: string;
  /** 出现时间，毫秒；映射给渲染器时统一换算为秒。 */
  progressMs: number;
  mode: DanmakuComment["mode"];
  color: string;
  content: string;
  pool: number;
};

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
      progressMs: Number.isFinite(item.progress) ? Math.max(0, Math.trunc(item.progress)) : 0,
      mode: videoDanmakuMode(item.mode),
      color: videoDanmakuColor(item.color),
      content,
      pool: Number.isFinite(item.pool) ? item.pool : 0,
    });
  }
  return entries.sort((left, right) => left.progressMs - right.progressMs);
}

/** 重复段号由调用方去重，此处只负责合并时间轴。 */
export function mergeVideoDanmakuEntries(
  segments: readonly (readonly VideoDanmakuEntry[])[],
): VideoDanmakuEntry[] {
  return segments.flat().sort((left, right) => left.progressMs - right.progressMs);
}

/** 只显示普通池（pool 0），字幕池、特殊池与屏蔽词命中的弹幕不进入渲染器。 */
export function filterVideoDanmakuEntries(
  entries: readonly VideoDanmakuEntry[],
  isShielded: (content: string) => boolean,
): VideoDanmakuEntry[] {
  return entries.filter((entry) => entry.pool === 0 && !isShielded(entry.content));
}

/** 弹幕侧栏跟随定位用的二分查找，不承担播放器弹幕投放。 */
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

/** 固定弹幕显示 15 秒媒体时间，暂停/缓冲期间不消耗时长。 */
export const VIDEO_DANMAKU_FIXED_DURATION_MS = DANMAKU_DEFAULT_DURATION_MS;

export function videoDanmakuComment(
  entry: VideoDanmakuEntry,
  options: { fontSize: number; fontStroke: number; opacity: number; reducedMotion?: boolean },
): DanmakuComment {
  const fontSize = clampDanmuFontSize(options.fontSize);
  const fontStroke = clampDanmuFontStroke(options.fontStroke);
  const mode = options.reducedMotion && entry.mode === "scroll" ? "top" : entry.mode;
  const style: NonNullable<DanmakuComment["style"]> = {
    color: entry.color,
    opacity: String(clampDanmuOpacity(options.opacity)),
    fontSize: `${fontSize}px`,
    fontWeight: DANMAKU_FONT_WEIGHT,
    height: `${danmuLaneHeight(fontSize)}px`,
    lineHeight: "1.35",
    whiteSpace: "nowrap",
    textShadow: "0 1px 2px rgba(0,0,0,.92), 0 0 3px rgba(0,0,0,.72)",
    pointerEvents: "none",
  };
  if (fontStroke > 0) {
    style.WebkitTextStroke = `${fontStroke}px rgba(0,0,0,.92)`;
    style.paintOrder = "stroke fill";
  }
  const comment: DanmakuComment = {
    id: entry.id,
    text: entry.content,
    time: entry.progressMs / 1_000,
    mode,
    ...(mode === "scroll" ? {} : { duration: VIDEO_DANMAKU_FIXED_DURATION_MS }),
    style,
  };
  // 自定义 DOM 只在原生调度实际投放时创建，沿用直播的安全文本和点选标记。
  comment.render = () => createDanmuBulletElement(comment);
  return comment;
}
