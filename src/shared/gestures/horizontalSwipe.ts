/**
 * 共享的横向页签/平台滑动助手。
 *
 * 触摸客户端上保持相同的左右导航契约，
 * 而不必引入完整的页面轮播组件。
 */

export const HORIZONTAL_SWIPE_DIRECTION_RATIO = 1.25;
export const HORIZONTAL_SWIPE_LOCK_DISTANCE_PX = 10;
export const HORIZONTAL_SWIPE_CLICK_SUPPRESSION_MS = 420;
/**
 * 跟手拖拽的硬上限（px）。位于任何现实视口宽度之上，
 * 使手机式平移受表面宽度（见下）约束而非固定推力 ——
 * 页面可以一路跟随手指横穿整个宽度。
 */
export const HORIZONTAL_SWIPE_MAX_DRAG_PX = 4096;
/**
 * 提交的页面在收尾前起始位置占表面的比例。`1` 表示进入页从整整一屏宽之外
 * 开始，释放呈现为一次连续的贴边平移，而不是短促的追赶推挤。
 */
export const HORIZONTAL_SWIPE_PAGE_ENTRY_RATIO = 1;
const HORIZONTAL_SWIPE_MAX_DRAG_SURFACE_RATIO = 1;
const HORIZONTAL_SWIPE_EDGE_RESISTANCE = 0.18;

/**
 * 慢速拖拽在改变页面之前必须覆盖的表面比例。
 *
 * 这是翻页契约的交互半边：决定提交的是页面实际走了多远，
 * 而不是手指移动了多少像素。四分之一表面：此时相邻页已经绘制完成并在跟手，
 * 拖到这里已经读作要翻页。中点附近则不算 —— 刻意的三分之一屏拖拽会弹回。
 */
export const HORIZONTAL_SWIPE_COMMIT_PROGRESS = 0.1;
/**
 * 释放速度阈值（px/ms），超过则无论进度如何都翻页。
 *
 * 约 0.32 px/ms 是利落但不夸张的一甩（约 320 px/s）。低于它视为位移拖拽，
 * 只按进度判断。
 */
export const HORIZONTAL_SWIPE_FLING_VELOCITY_PX_PER_MS = 0.32;
/** 释放收尾时长的边界（ms）。 */
export const HORIZONTAL_SWIPE_SETTLE_MIN_MS = 170;
export const HORIZONTAL_SWIPE_SETTLE_MAX_MS = 400;
/**
 * 收尾时长在其间推导的速度窗口（px/ms）。
 *
 * 收尾延续手指已经开始的运动，因此时长来自剩余距离除以释放速度。钳制速度避免
 * 近乎原地松手产生数秒的蠕动，也避免猛烈一甩在一帧内瞬间到位。
 */
export const HORIZONTAL_SWIPE_SETTLE_MIN_SPEED = 0.7;
export const HORIZONTAL_SWIPE_SETTLE_MAX_SPEED = 3;
/**
 * 释放速度的采样窗口（ms）。
 *
 * 指针样本每个合成帧至多一个，单对事件噪声很大。在约两帧上平滑既能防止稳定的
 * 拖拽被误判为一甩，又能在同一手势内及时反应。
 */
export const HORIZONTAL_SWIPE_VELOCITY_WINDOW_MS = 32;

export type HorizontalSwipeSample = {
  /** 手势轴上的指针位置（px）。 */
  x: number;
  /** 采样时刻的 `performance.now()`。 */
  time: number;
};

/**
 * 由样本尾部计算的沿手势轴释放速度（px/ms）。
 *
 * pointermove 大约每个合成帧一个，只对最后两个事件求差分足以把稳定的拖拽误读成
 * 一甩。对 `windowMs` 窗口内的样本取平均可以平滑掉这一点；由于窗口从最新样本
 * 往回量，抬起前停顿过的手指上报约 0，
 * 而不是继承停顿前的速度。
 */
export function horizontalSwipeVelocity(
  samples: readonly HorizontalSwipeSample[],
  windowMs: number = HORIZONTAL_SWIPE_VELOCITY_WINDOW_MS,
): number {
  const latest = samples[samples.length - 1];
  if (!latest) return 0;
  let oldest = latest;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (latest.time - sample.time > windowMs) break;
    oldest = sample;
  }
  const elapsed = latest.time - oldest.time;
  if (elapsed <= 0) return 0;
  return (latest.x - oldest.x) / elapsed;
}

/**
 * 实时拖拽当前覆盖的带符号表面比例。
 *
 * 翻页过渡正是对这个值插值：±1 时相邻页已完全取代当前页。
 */
export function horizontalSwipeProgress(dragOffset: number, surfaceWidth: number): number {
  if (!(surfaceWidth > 0)) return 0;
  return Math.max(-1, Math.min(1, dragOffset / surfaceWidth));
}

/**
 * 在此释放是否应落在拖拽所指向的相邻页上。
 *
 * 拖拽自身的符号挑选候选页；这里只决定提交还是回弹，与手机翻页器一致：
 *
 * - 与拖拽方向一致的一甩在任何距离上都提交，快速轻甩不必划过整屏也能翻页；
 * - 朝起点方向甩回则在任何距离上取消，拖过中点又拉回去不会违背用户最后意图地
 * 翻页；
 * - 否则按位置决定 —— 页面实际走过了多少表面。
 */
export function horizontalSwipeShouldCommit(
  dragOffset: number,
  velocity: number,
  surfaceWidth: number,
): boolean {
  if (dragOffset === 0) return false;
  const advancing = dragOffset < 0;
  const fling = HORIZONTAL_SWIPE_FLING_VELOCITY_PX_PER_MS;
  if (advancing ? velocity <= -fling : velocity >= fling) return true;
  if (advancing ? velocity >= fling : velocity <= -fling) return false;
  return (
    Math.abs(horizontalSwipeProgress(dragOffset, surfaceWidth)) >= HORIZONTAL_SWIPE_COMMIT_PROGRESS
  );
}

/** 指针释放时条带落点的下标；null 保持原位。负偏移（手指左移）前进；正值后退。 */
export function horizontalSwipeTargetIndex(
  currentIndex: number,
  length: number,
  dragOffset: number,
  velocity: number,
  surfaceWidth: number,
): number | null {
  if (length <= 1 || currentIndex < 0 || currentIndex >= length) return null;
  if (!horizontalSwipeShouldCommit(dragOffset, velocity, surfaceWidth)) return null;
  const nextIndex = currentIndex + (dragOffset < 0 ? 1 : -1);
  return nextIndex < 0 || nextIndex >= length ? null : nextIndex;
}

export function horizontalSwipeTargetItem<T>(
  items: readonly T[],
  current: T,
  dragOffset: number,
  velocity: number,
  surfaceWidth: number,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T | null {
  const currentIndex = items.findIndex((item) => isEqual(item, current));
  const nextIndex = horizontalSwipeTargetIndex(
    currentIndex,
    items.length,
    dragOffset,
    velocity,
    surfaceWidth,
  );
  return nextIndex === null ? null : (items[nextIndex] ?? null);
}

/**
 * 释放覆盖剩余距离所需的时长（ms）。
 *
 * 收尾延续手势而不是播放一段固定动画，因此时长取决于剩余距离与松手速度。
 * 速度经过钳制，近原地松手不会蠕动、猛甩也不会在一帧内瞬移；结果再次钳制，
 * 使总时长保持在读作一次连续运动的范围内。
 */
export function horizontalSwipeSettleDuration(distance: number, velocity: number): number {
  const remaining = Math.abs(distance);
  if (remaining < 1) return 0;
  const speed = Math.min(
    HORIZONTAL_SWIPE_SETTLE_MAX_SPEED,
    Math.max(HORIZONTAL_SWIPE_SETTLE_MIN_SPEED, Math.abs(velocity)),
  );
  return Math.round(
    Math.min(
      HORIZONTAL_SWIPE_SETTLE_MAX_MS,
      Math.max(HORIZONTAL_SWIPE_SETTLE_MIN_MS, remaining / speed),
    ),
  );
}

/**
 * 页面跟手时使用的横向偏移。
 *
 * 有效方向上跟手最多一整个表面宽度，页面可以像手机导航那样贴边平移。
 * 在第一/最后一页同样的移动被大幅阻尼，
 * 既让边界可见又不暗示条带可以环绕。
 */
export function horizontalSwipeDragOffset(
  currentIndex: number,
  length: number,
  deltaX: number,
  surfaceWidth: number,
): number {
  if (length <= 0 || currentIndex < 0 || currentIndex >= length) return 0;

  const maxTravel = Math.min(
    HORIZONTAL_SWIPE_MAX_DRAG_PX,
    Math.max(0, surfaceWidth) * HORIZONTAL_SWIPE_MAX_DRAG_SURFACE_RATIO,
  );
  const boundedOffset = Math.max(-maxTravel, Math.min(maxTravel, deltaX));
  const nextIndex = currentIndex + (deltaX < 0 ? 1 : -1);
  const atBoundary = nextIndex < 0 || nextIndex >= length;
  return atBoundary ? boundedOffset * HORIZONTAL_SWIPE_EDGE_RESISTANCE : boundedOffset;
}

/** 把全宽翻页 track 定位到指定项。 */
export function horizontalSwipeTrackOffset(index: number, surfaceWidth: number): number {
  const normalizedIndex = Math.max(0, index);
  const width = Math.max(0, surfaceWidth);
  return normalizedIndex === 0 || width === 0 ? 0 : -normalizedIndex * width;
}

/**
 * 围绕新选中的页面重建已提交拖拽的基准，但不改变手指下方当前的像素。
 * 新页面成为 track 原点，因此在收尾归零之前沿导航方向加上一个页宽。
 */
export function horizontalSwipeCommitOffset(
  dragOffset: number,
  direction: 1 | -1,
  surfaceWidth: number,
): number {
  const entry = Math.max(0, surfaceWidth) * HORIZONTAL_SWIPE_PAGE_ENTRY_RATIO;
  return dragOffset + direction * entry;
}

/**
 * 连续横向手势（滑杆、文本框）和显式拖拽把手拥有指针。
 * 普通按钮和列表行保持可滑动；识别出的滑动会抑制 Android WebView
 * 可能仍会发出的合成 click。
 */
export function isHorizontalSwipeIgnoredTarget(target: EventTarget | null): boolean {
  if (!target || typeof Element === "undefined" || typeof Node === "undefined") return false;
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return Boolean(
    element?.closest(
      'input, textarea, select, [contenteditable="true"], [role="slider"], [role="combobox"], [data-dnd-handle], [data-slot="drawer-content"], [data-slot="slider"], [data-slot^="slider-"], [data-slot="scroll-area-scrollbar"], [data-slot="scroll-area-thumb"]',
    ),
  );
}
