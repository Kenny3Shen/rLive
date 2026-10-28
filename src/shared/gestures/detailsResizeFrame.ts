import { detailsContentScrollStep } from "./detailsResize";

export type DetailsResizeCursor = {
  percent: number;
  /** 当前手势的滚动链逻辑位置；正数向下。 */
  scrollTop: number;
};

export type DetailsResizeFrameBounds = {
  containerHeight: number;
  minPercent: number;
  maxPercent: number;
  maxScrollTop: number;
};

export type DetailsResizeFrameResult = {
  cursor: DetailsResizeCursor;
  /** 本帧对滚动链的净位移；正数向下。 */
  scrollDelta: number;
  /**
   * 是否需要重读真实滚动链：下滑要先回顶部，任一步也可能在裁剪前请求滚动。
   * 滚动位置可被弹幕跟随或评论定位程序化改变，不能始终信任按压时的快照。
   */
  needsScrollMetrics: boolean;
  percentChanged: boolean;
};

type FrameScheduler = (callback: (time: number) => void) => number;
type FrameCanceller = (handle: number) => void;

export type DetailsResizeFrameQueue = {
  schedule: () => boolean;
  flush: (time?: number) => boolean;
  cancel: () => boolean;
  isScheduled: () => boolean;
};

export type DetailsResizeFrameQueueOptions = {
  requestFrame?: FrameScheduler;
  cancelFrame?: FrameCanceller;
};

/**
 * 可注入调度器的单帧队列。cancel/reset 会让已排队的旧回调失效，避免卸载后
 * 仍写布局；hook 与实际 RTL 共用这一份调度，不另做测试替身。
 */
export function createDetailsResizeFrameQueue(
  onFrame: (time: number) => void,
  options: DetailsResizeFrameQueueOptions = {},
): DetailsResizeFrameQueue {
  const requestFrame =
    options.requestFrame ?? ((callback: (time: number) => void) => requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  let handle: number | null = null;
  let generation = 0;

  const cancel = () => {
    if (handle === null) return false;
    cancelFrame(handle);
    handle = null;
    generation += 1;
    return true;
  };

  const schedule = () => {
    if (handle !== null) return false;
    const token = generation;
    handle = requestFrame((time) => {
      if (handle === null || token !== generation) return;
      handle = null;
      onFrame(time);
    });
    return true;
  };

  const flush = (time = performance.now()) => {
    if (handle === null) return false;
    cancelFrame(handle);
    handle = null;
    generation += 1;
    onFrame(time);
    return true;
  };

  return {
    schedule,
    flush,
    cancel,
    isScheduled: () => handle !== null,
  };
}

function clampScrollTop(value: number, maxScrollTop: number): number {
  return Math.min(maxScrollTop, Math.max(0, value));
}

/**
 * 按顺序消费一帧内的所有位移。不能先求 net delta：上滑到边界后再下滑时，
 * 前半段应进入滚动，后半段却应马上缩回侧栏。
 */
export function consumeDetailsResizeDeltas(
  cursor: DetailsResizeCursor,
  deltas: readonly number[],
  bounds: DetailsResizeFrameBounds,
): DetailsResizeFrameResult {
  const maxScrollTop = Number.isFinite(bounds.maxScrollTop)
    ? Math.max(0, bounds.maxScrollTop)
    : 0;
  let percent = cursor.percent;
  let scrollTop = clampScrollTop(cursor.scrollTop, maxScrollTop);
  const startScrollTop = scrollTop;
  const startPercent = percent;
  let needsScrollMetrics = false;

  for (const deltaY of deltas) {
    if (!Number.isFinite(deltaY) || deltaY === 0) continue;
    // 下滑先回顶。真实 top 可能已由列表跟随等程序化滚动改过，必须重新读取。
    if (deltaY > 1e-9) needsScrollMetrics = true;
    const step = detailsContentScrollStep(
      percent,
      deltaY,
      scrollTop,
      bounds.containerHeight,
      bounds.maxPercent,
      bounds.minPercent,
    );
    if (Math.abs(step.scrollDelta) >= 1e-9) needsScrollMetrics = true;
    percent = step.percent;
    scrollTop = clampScrollTop(scrollTop + step.scrollDelta, maxScrollTop);
  }

  return {
    cursor: { percent, scrollTop },
    scrollDelta: scrollTop - startScrollTop,
    needsScrollMetrics,
    percentChanged: Math.abs(percent - startPercent) > 1e-9,
  };
}
