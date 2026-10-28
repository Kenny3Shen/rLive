import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import {
  clampDetailsSharePercent,
  DETAILS_MOMENTUM_MIN_VELOCITY,
  DETAILS_MOMENTUM_SAMPLE_LIMIT,
  DETAILS_MOMENTUM_STOP_VELOCITY,
  DETAILS_RESIZE_TAP_SUPPRESSION_MS,
  detailsContentScrollStep,
  detailsMomentumStep,
  detailsResizeIntent,
  detailsResizeLayout,
  detailsResizePressIsHold,
  detailsResizeStepIsVisible,
  detailsResizeVelocity,
  detailsShareCssValue,
  roundDetailsShare,
  type DetailsMomentumSample,
  type DetailsResizeLayout,
} from "@/shared/gestures/detailsResize";
import {
  consumeDetailsResizeDeltas,
  createDetailsResizeFrameQueue,
  type DetailsResizeCursor,
  type DetailsResizeFrameBounds,
  type DetailsResizeFrameResult,
} from "@/shared/gestures/detailsResizeFrame";
import {
  detailsResizeTransform,
  type DetailsResizeTransform,
  type DetailsResizeTransformInput,
} from "@/shared/gestures/detailsResizeTransform";
import { detailsScrollMetrics, scrollDetailsContent } from "@/shared/gestures/detailsScroll";

type MeasuredLayout = {
  width: number;
  height: number;
  aspectRatio: number | null;
  layout: DetailsResizeLayout | null;
};

type ResizePress = {
  touchId: number;
  startX: number;
  startY: number;
  lastY: number;
  target: Element;
  scrollers: HTMLElement[] | null;
  scrollTop: number;
  maxScrollTop: number;
  intent: "pending" | "resize" | "swipe";
  /**
   * 轴锁前已对本次触摸调用过 `preventDefault`。一旦拦过就必须在锁定前持续拦截：
   * 慢速上滑时后续 move 的单步位移常不足 1px，若中途放行一次，合成器就把触摸
   * 交给原生滚动并派发 pointercancel，之后的 move 不可取消，侧栏不再跟手。
   */
  claimed: boolean;
  pressedAt: number;
  samples: DetailsMomentumSample[];
};

type ResizeGesture = {
  touchId: number;
  scrollers: HTMLElement[];
  baseStageHeight: number;
  cursor: DetailsResizeCursor;
  bounds: DetailsResizeFrameBounds;
  deltas: number[];
};

type MomentumState = {
  velocity: number;
  lastTime: number;
  scrollers: HTMLElement[];
  baseStageHeight: number;
  cursor: DetailsResizeCursor;
  bounds: DetailsResizeFrameBounds;
  frame: number | null;
};

type DetailsResizeRenderTargets = {
  playerFrame: HTMLElement | null;
  playerStage: HTMLElement | null;
  surface: HTMLElement | null;
  controls: HTMLElement | null;
  aside: HTMLElement | null;
  composer: HTMLElement | null;
  asr: HTMLElement | null;
};

export type UseDetailsResizeOptions = {
  enabled: boolean;
  aspectRatio: number | null;
  containerRef: RefObject<HTMLElement | null>;
  /** 视频/分 P 身份；变化时恢复原始布局。 */
  resetKey: string;
};

function contentScrollers(target: Element, viewport: HTMLElement): HTMLElement[] {
  const scrollers: HTMLElement[] = [];
  for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
    if (
      node instanceof HTMLElement &&
      /^(auto|scroll)$/.test(getComputedStyle(node).overflowY) &&
      node.scrollHeight > node.clientHeight
    ) {
      scrollers.push(node);
    }
  }
  return scrollers;
}

function clampScrollTop(value: number, maxScrollTop: number): number {
  return Math.min(maxScrollTop, Math.max(0, value));
}

const resizeTargetCache = new WeakMap<HTMLElement, DetailsResizeRenderTargets>();
const detailsShareProperty = "--vod-details-share";

function queryResizeTargets(container: HTMLElement): DetailsResizeRenderTargets {
  return {
    playerFrame: container.querySelector<HTMLElement>("[data-vod-details-stage]"),
    playerStage: container.querySelector<HTMLElement>("[data-vod-details-player-stage]"),
    surface: container.querySelector<HTMLElement>("[data-vod-details-media-surface]"),
    controls: container.querySelector<HTMLElement>("[data-vod-details-controls]"),
    aside: container.querySelector<HTMLElement>("[data-vod-details-aside]"),
    composer: container.querySelector<HTMLElement>("[data-vod-details-composer]"),
    asr: container.querySelector<HTMLElement>('[data-vod-details-resize-anchor="true"]'),
  };
}

function getResizeTargets(container: HTMLElement): DetailsResizeRenderTargets {
  let targets = resizeTargetCache.get(container);
  if (
    !targets ||
    !targets.playerFrame?.isConnected ||
    !targets.playerStage?.isConnected ||
    !targets.surface?.isConnected ||
    !targets.aside?.isConnected
  ) {
    targets = queryResizeTargets(container);
    resizeTargetCache.set(container, targets);
    return targets;
  }

  // 字幕和发送框会按状态/页签挂载；缺失时继续按帧查找，出现后立即接上变换。
  if (!targets.controls) {
    targets.controls = container.querySelector<HTMLElement>("[data-vod-details-controls]");
  }
  if (targets.controls && !targets.controls.isConnected) {
    targets.controls = container.querySelector<HTMLElement>("[data-vod-details-controls]");
  }
  if (!targets.composer) {
    targets.composer = container.querySelector<HTMLElement>("[data-vod-details-composer]");
  }
  if (targets.composer && !targets.composer.isConnected) {
    targets.composer = container.querySelector<HTMLElement>("[data-vod-details-composer]");
  }
  if (!targets.asr) {
    targets.asr = container.querySelector<HTMLElement>('[data-vod-details-resize-anchor="true"]');
  }
  if (targets.asr && !targets.asr.isConnected) {
    targets.asr = container.querySelector<HTMLElement>('[data-vod-details-resize-anchor="true"]');
  }
  return targets;
}

function setResizeStyle(element: HTMLElement | null, property: string, value: string): void {
  if (element && element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
}

function setResizeState(element: HTMLElement | null, attribute: string, active: boolean): void {
  if (!element) return;
  if (active) {
    if (!element.hasAttribute(attribute)) element.setAttribute(attribute, "true");
  } else {
    element.removeAttribute(attribute);
  }
}

/**
 * `--vod-details-share` 是不继承的注册属性，主容器上的值不会到达子元素。
 * 占比同时写在实际消费它的舞台与 aside 上，清理时也从同一组目标移除。
 */
function syncDetailsShareTargets(
  container: HTMLElement,
  targets: DetailsResizeRenderTargets,
): void {
  const value = container.style.getPropertyValue(detailsShareProperty);
  for (const target of [targets.playerFrame, targets.aside]) {
    if (!target) continue;
    if (value) {
      setResizeStyle(target, detailsShareProperty, value);
    } else {
      target.style.removeProperty(detailsShareProperty);
    }
  }
}

/**
 * prepared/resizing 只写在实际消费样式的元素上，主容器不匹配其后代。
 * 可选元素晚挂载时也在这里补上状态，避免必须重新进入一次手势。
 */
function syncResizeTargetState(container: HTMLElement): void {
  const targets = getResizeTargets(container);
  syncDetailsShareTargets(container, targets);
  const prepared = container.dataset.vodDetailsPrepared === "true";
  const resizing = container.dataset.vodDetailsResizing === "true";
  // 只有进入拖动后才需要放开 player stage 的裁切；单纯按下预备不应改变层级裁切。
  setResizeState(targets.playerStage, "data-vod-details-overflow", resizing);
  setResizeState(targets.aside, "data-vod-details-prepared", prepared);
  setResizeState(targets.composer, "data-vod-details-prepared", prepared);
  setResizeState(targets.surface, "data-vod-details-resizing", resizing);
  setResizeState(targets.controls, "data-vod-details-resizing", resizing);
  setResizeState(targets.asr, "data-vod-details-resizing", resizing);
  setResizeState(targets.aside, "data-vod-details-resizing", resizing);
}

function resizeOffsetValue(value: number): string {
  return `${value.toFixed(4)}px`;
}

function writeResizeTransform(container: HTMLElement, transform: DetailsResizeTransform): void {
  const targets = getResizeTargets(container);
  setResizeStyle(targets.surface, "--vod-resize-stage-scale", transform.stageScale.toFixed(6));
  setResizeStyle(
    targets.controls,
    "--vod-resize-chrome-offset",
    resizeOffsetValue(transform.chromeOffset),
  );
  setResizeStyle(
    targets.asr,
    "--vod-resize-chrome-offset",
    resizeOffsetValue(transform.chromeOffset),
  );
  setResizeStyle(
    targets.aside,
    "--vod-resize-aside-height",
    resizeOffsetValue(transform.maxAsideHeight),
  );
  setResizeStyle(
    targets.aside,
    "--vod-resize-aside-offset",
    resizeOffsetValue(transform.asideOffset),
  );
  setResizeStyle(
    targets.composer,
    "--vod-resize-composer-offset",
    resizeOffsetValue(transform.composerOffset),
  );
  syncResizeTargetState(container);
}

function clearResizeTransform(container: HTMLElement | null): void {
  if (!container) return;
  const properties = [
    "--vod-resize-stage-scale",
    "--vod-resize-chrome-offset",
    "--vod-resize-aside-height",
    "--vod-resize-aside-offset",
    "--vod-resize-composer-offset",
  ];
  const elements = new Set<HTMLElement | null>([
    container.querySelector<HTMLElement>("[data-vod-details-stage]"),
    container.querySelector<HTMLElement>("[data-vod-details-player-stage]"),
    container.querySelector<HTMLElement>("[data-vod-details-media-surface]"),
    ...container.querySelectorAll<HTMLElement>("[data-vod-details-controls]"),
    container.querySelector<HTMLElement>("[data-vod-details-aside]"),
    ...container.querySelectorAll<HTMLElement>("[data-vod-details-composer]"),
    ...container.querySelectorAll<HTMLElement>('[data-vod-details-resize-anchor="true"]'),
  ]);
  for (const element of elements) {
    if (!element) continue;
    for (const property of properties) element.style.removeProperty(property);
  }
  syncResizeTargetState(container);
}

function enterPreparedMode(
  container: HTMLElement | null,
  input: DetailsResizeTransformInput,
): boolean {
  if (!container) return false;
  const transform = detailsResizeTransform(input);
  if (!transform) return false;
  // 先写 aside 上限高度和 composer 补偿，再切换标记；此时视频仍保持真实布局。
  writeResizeTransform(container, transform);
  markDetailsPrepared(container, true);
  syncResizeTargetState(container);
  return true;
}

function enterResizeMode(
  container: HTMLElement | null,
  input: DetailsResizeTransformInput,
): boolean {
  if (!container) return false;
  const transform = detailsResizeTransform(input);
  if (!transform) return false;
  writeResizeTransform(container, transform);
  markDetailsPrepared(container, true);
  markDetailsResizing(container, true);
  syncResizeTargetState(container);
  return true;
}

function settleResizeMode(container: HTMLElement | null, percent: number): void {
  if (!container) return;
  // 同一任务内先落到最终真实布局，再撤掉临时布局和变换；浏览器只绘制最终结果。
  writeDetailsShare(container, percent);
  markDetailsPrepared(container, false);
  clearDetailsResizing(container);
  clearResizeTransform(container);
  syncResizeTargetState(container);
}

/**
 * 移动端 VOD 侧栏占比。事件只更新坐标与待消费位移，测量和 DOM 写入全部收口到
 * 单个 RAF；静态布局只由同一个占比表达，按下预备后拖动不再改变真实布局。
 */
export function useDetailsResize({
  enabled,
  aspectRatio,
  containerRef,
  resetKey,
}: UseDetailsResizeOptions) {
  const enabledRef = useRef(enabled);
  const aspectRatioRef = useRef(aspectRatio);
  const resetKeyRef = useRef(resetKey);
  const previousAspectRatioRef = useRef(aspectRatio);
  const geometryRef = useRef<MeasuredLayout | null>(null);
  const currentPercentRef = useRef<number | null>(null);
  const userAdjustedRef = useRef(false);
  const pressRef = useRef<ResizePress | null>(null);
  const gestureRef = useRef<ResizeGesture | null>(null);
  const momentumRef = useRef<MomentumState | null>(null);
  const preparedStageHeightRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  const frameQueueRef = useRef<ReturnType<typeof createDetailsResizeFrameQueue> | null>(null);

  const settlePreparedLayout = useCallback(
    (percent: number) => {
      preparedStageHeightRef.current = null;
      settleResizeMode(containerRef.current, percent);
    },
    [containerRef],
  );

  const prepareResize = useCallback(
    (containerHeight: number, layout: DetailsResizeLayout, percent: number): number | null => {
      const preparedPercent = roundDetailsShare(percent);
      const stageHeight = ((100 - preparedPercent) / 100) * containerHeight;
      if (!(stageHeight > 0)) return null;
      const entered = enterPreparedMode(containerRef.current, {
        containerHeight,
        stageHeight,
        minPercent: layout.minPercent,
        currentPercent: preparedPercent,
        maxPercent: layout.maxPercent,
      });
      if (!entered) return null;
      currentPercentRef.current = preparedPercent;
      preparedStageHeightRef.current = stageHeight;
      return stageHeight;
    },
    [containerRef],
  );

  const measureLayout = useCallback(
    (width?: number, height?: number): MeasuredLayout | null => {
      const container = containerRef.current;
      if (!container) return null;
      const measuredWidth = width ?? container.clientWidth;
      const measuredHeight = height ?? container.clientHeight;
      const cached = geometryRef.current;
      if (
        cached &&
        Math.abs(cached.width - measuredWidth) < 0.5 &&
        Math.abs(cached.height - measuredHeight) < 0.5 &&
        Object.is(cached.aspectRatio, aspectRatioRef.current)
      ) {
        return cached;
      }
      const measured: MeasuredLayout = {
        width: measuredWidth,
        height: measuredHeight,
        aspectRatio: aspectRatioRef.current,
        layout: detailsResizeLayout(measuredWidth, measuredHeight, aspectRatioRef.current),
      };
      geometryRef.current = measured;
      return measured;
    },
    [containerRef],
  );

  const initializeLayout = useCallback(
    (width?: number, height?: number): MeasuredLayout | null => {
      const container = containerRef.current;
      if (!container || !enabledRef.current) return null;
      const measured = measureLayout(width, height);
      if (!measured?.layout) {
        clearDetailsLayout(container);
        return measured;
      }
      const percent = userAdjustedRef.current
        ? clampDetailsSharePercent(
            currentPercentRef.current ?? measured.layout.initialPercent,
            measured.layout.maxPercent,
            measured.layout.minPercent,
          )
        : measured.layout.initialPercent;
      currentPercentRef.current = percent;
      settlePreparedLayout(percent);
      return measured;
    },
    [containerRef, measureLayout, settlePreparedLayout],
  );

  const applyFrameResult = useCallback(
    (
      cursorBefore: DetailsResizeCursor,
      scrollers: readonly HTMLElement[],
      result: DetailsResizeFrameResult,
      baseStageHeight: number,
      bounds: DetailsResizeFrameBounds,
    ): DetailsResizeCursor => {
      const applied = scrollDetailsContent(scrollers, result.scrollDelta);
      let cursor = result.cursor;
      if (applied !== result.scrollDelta) {
        cursor = {
          percent: result.cursor.percent,
          scrollTop: clampScrollTop(cursorBefore.scrollTop + applied, bounds.maxScrollTop),
        };
      }
      if (result.percentChanged) {
        const container = containerRef.current;
        if (container) {
          const transform = detailsResizeTransform({
            containerHeight: bounds.containerHeight,
            stageHeight: baseStageHeight,
            minPercent: bounds.minPercent,
            currentPercent: cursor.percent,
            maxPercent: bounds.maxPercent,
          });
          if (transform) writeResizeTransform(container, transform);
        }
        userAdjustedRef.current = true;
      }
      currentPercentRef.current = cursor.percent;
      return cursor;
    },
    [containerRef],
  );

  const consumeFrame = useCallback(
    (
      cursor: DetailsResizeCursor,
      scrollers: readonly HTMLElement[],
      deltas: readonly number[],
      bounds: DetailsResizeFrameBounds,
    ): {
      cursor: DetailsResizeCursor;
      result: DetailsResizeFrameResult;
      bounds: DetailsResizeFrameBounds;
    } => {
      let result = consumeDetailsResizeDeltas(cursor, deltas, bounds);
      if (!result.needsScrollMetrics) {
        result = {
          ...result,
          cursor: { ...result.cursor, scrollTop: cursor.scrollTop },
        };
        return { cursor, result, bounds };
      }
      // 只有真正要滚内容时才读 DOM；侧栏缩放和异步追加都会改变可滚余量。
      const metrics = detailsScrollMetrics(scrollers);
      const refreshedCursor = { percent: cursor.percent, scrollTop: metrics.top };
      const refreshedBounds = { ...bounds, maxScrollTop: metrics.maxTop };
      return {
        cursor: refreshedCursor,
        result: consumeDetailsResizeDeltas(refreshedCursor, deltas, refreshedBounds),
        bounds: refreshedBounds,
      };
    },
    [],
  );

  const flushGesture = useCallback(
    (gesture: ResizeGesture) => {
      if (gesture.deltas.length === 0) return;
      const deltas = gesture.deltas;
      gesture.deltas = [];
      const consumed = consumeFrame(gesture.cursor, gesture.scrollers, deltas, gesture.bounds);
      gesture.bounds = consumed.bounds;
      gesture.cursor = applyFrameResult(
        consumed.cursor,
        gesture.scrollers,
        consumed.result,
        gesture.baseStageHeight,
        consumed.bounds,
      );
    },
    [applyFrameResult, consumeFrame],
  );

  useLayoutEffect(() => {
    const queue = createDetailsResizeFrameQueue(() => {
      const gesture = gestureRef.current;
      if (gesture) flushGesture(gesture);
    });
    frameQueueRef.current = queue;
    return () => {
      queue.cancel();
      if (frameQueueRef.current === queue) frameQueueRef.current = null;
    };
  }, [flushGesture]);

  const stopMomentum = useCallback(
    (commit: boolean) => {
      const momentum = momentumRef.current;
      momentumRef.current = null;
      if (!momentum) return false;
      if (momentum.frame !== null) window.cancelAnimationFrame(momentum.frame);
      settlePreparedLayout(momentum.cursor.percent);
      if (commit) {
        suppressClickUntilRef.current = Date.now() + DETAILS_RESIZE_TAP_SUPPRESSION_MS;
      }
      return true;
    },
    [settlePreparedLayout],
  );

  const finishGesture = useCallback(
    (suppressClick: boolean, flushPending: boolean, preserveUnclaimedPress = false) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture || !preserveUnclaimedPress) pressRef.current = null;
      if (gesture) {
        frameQueueRef.current?.cancel();
        if (flushPending) flushGesture(gesture);
      }
      const percent = gesture?.cursor.percent ?? currentPercentRef.current;
      if ((gesture || preparedStageHeightRef.current !== null) && percent !== null) {
        settlePreparedLayout(percent);
      }
      if (gesture && suppressClick) {
        suppressClickUntilRef.current = Date.now() + DETAILS_RESIZE_TAP_SUPPRESSION_MS;
      }
    },
    [flushGesture, settlePreparedLayout],
  );

  const startMomentum = useCallback(
    (
      velocity: number,
      cursor: DetailsResizeCursor,
      scrollers: HTMLElement[],
      baseStageHeight: number,
      bounds: DetailsResizeFrameBounds,
    ) => {
      stopMomentum(false);
      const momentum: MomentumState = {
        velocity,
        lastTime: performance.now(),
        scrollers,
        baseStageHeight,
        cursor,
        bounds,
        frame: null,
      };
      momentumRef.current = momentum;
      const entered = enterResizeMode(containerRef.current, {
        containerHeight: bounds.containerHeight,
        stageHeight: baseStageHeight,
        minPercent: bounds.minPercent,
        currentPercent: cursor.percent,
        maxPercent: bounds.maxPercent,
      });
      if (!entered) {
        momentumRef.current = null;
        settlePreparedLayout(cursor.percent);
        return;
      }

      const step = (now: number) => {
        if (momentumRef.current !== momentum) return;
        momentum.frame = null;
        const dt = now - momentum.lastTime;
        momentum.lastTime = now;
        const motion = detailsMomentumStep(momentum.velocity, dt);
        momentum.velocity = motion.velocity;
        const before = momentum.cursor;
        const consumed = consumeFrame(before, momentum.scrollers, [motion.delta], momentum.bounds);
        momentum.bounds = consumed.bounds;
        momentum.cursor = applyFrameResult(
          consumed.cursor,
          momentum.scrollers,
          consumed.result,
          momentum.baseStageHeight,
          consumed.bounds,
        );
        const stalled =
          Math.abs(momentum.cursor.percent - before.percent) < 1e-9 &&
          Math.abs(momentum.cursor.scrollTop - before.scrollTop) < 1e-9;
        if (stalled || Math.abs(momentum.velocity) < DETAILS_MOMENTUM_STOP_VELOCITY) {
          stopMomentum(true);
          return;
        }
        momentum.frame = window.requestAnimationFrame(step);
      };
      momentum.frame = window.requestAnimationFrame(step);
    },
    [applyFrameResult, consumeFrame, containerRef, settlePreparedLayout, stopMomentum],
  );

  const ensurePressScroll = useCallback(
    (press: ResizePress, viewport: HTMLElement, refresh = false) => {
      if (press.scrollers && !refresh) return;
      const scrollers = press.scrollers ?? contentScrollers(press.target, viewport);
      press.scrollers = scrollers;
      const metrics = detailsScrollMetrics(scrollers);
      press.scrollTop = metrics.top;
      press.maxScrollTop = metrics.maxTop;
    },
    [],
  );

  const beginGesture = useCallback(
    (
      press: ResizePress,
      measured: MeasuredLayout,
      cursor: DetailsResizeCursor,
    ): ResizeGesture | null => {
      if (!enabledRef.current) return null;
      if (!measured?.layout) return null;
      const pressCursor = {
        percent: roundDetailsShare(cursor.percent),
        scrollTop: cursor.scrollTop,
      };
      currentPercentRef.current = pressCursor.percent;
      const baseStageHeight =
        preparedStageHeightRef.current ??
        prepareResize(measured.height, measured.layout, pressCursor.percent);
      if (baseStageHeight === null) return null;
      const entered = enterResizeMode(containerRef.current, {
        containerHeight: measured.height,
        stageHeight: baseStageHeight,
        minPercent: measured.layout.minPercent,
        currentPercent: pressCursor.percent,
        maxPercent: measured.layout.maxPercent,
      });
      if (!entered) return null;
      const gesture: ResizeGesture = {
        touchId: press.touchId,
        scrollers: press.scrollers ?? [],
        baseStageHeight,
        cursor: pressCursor,
        bounds: {
          containerHeight: measured.height,
          minPercent: measured.layout.minPercent,
          maxPercent: measured.layout.maxPercent,
          maxScrollTop: press.maxScrollTop,
        },
        deltas: [],
      };
      gestureRef.current = gesture;
      return gesture;
    },
    [containerRef, prepareResize],
  );

  const bindContent = useCallback(
    (viewport: HTMLDivElement | null) => {
      if (!viewport) return;

      const start = (event: TouchEvent) => {
        if (stopMomentum(true)) {
          suppressClickUntilRef.current = Date.now() + DETAILS_RESIZE_TAP_SUPPRESSION_MS;
        }
        if (event.touches.length !== 1) {
          finishGesture(false, false);
          return;
        }
        const target = event.target;
        if (!(target instanceof Element) || !viewport.contains(target)) return;
        if (
          target.closest(
            'input, textarea, select, [contenteditable="true"], [role="slider"], [role="switch"], [role="dialog"], [data-slot="scroll-area-scrollbar"]',
          )
        ) {
          return;
        }
        const touch = event.touches[0];
        pressRef.current = {
          touchId: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          lastY: touch.clientY,
          target,
          scrollers: null,
          scrollTop: 0,
          maxScrollTop: 0,
          intent: "pending",
          claimed: false,
          pressedAt: event.timeStamp,
          samples: [{ time: event.timeStamp, y: touch.clientY }],
        };
        if (enabledRef.current) {
          const measured = geometryRef.current ?? initializeLayout();
          if (measured?.layout) {
            prepareResize(
              measured.height,
              measured.layout,
              currentPercentRef.current ?? measured.layout.initialPercent,
            );
          }
        }
      };

      const claimPendingMove = (
        event: TouchEvent,
        press: ResizePress,
        offsetX: number,
        offsetY: number,
        deltaY: number,
      ) => {
        if (!event.cancelable || !enabledRef.current) return;
        if (Math.abs(offsetY) <= Math.abs(offsetX)) return;
        if (press.claimed) {
          event.preventDefault();
          return;
        }
        const measured = geometryRef.current ?? initializeLayout();
        if (!measured?.layout) return;
        ensurePressScroll(press, viewport);
        const percent = currentPercentRef.current ?? measured.layout.initialPercent;
        const next = detailsContentScrollStep(
          percent,
          deltaY,
          press.scrollTop,
          measured.height,
          measured.layout.maxPercent,
          measured.layout.minPercent,
        );
        if (detailsResizeStepIsVisible(percent, next.percent, measured.height)) {
          press.claimed = true;
          event.preventDefault();
        }
      };

      const move = (event: TouchEvent) => {
        const press = pressRef.current;
        if (!press) return;
        if (event.touches.length !== 1) {
          finishGesture(false, false);
          return;
        }
        const touch = Array.from(event.touches).find((item) => item.identifier === press.touchId);
        if (!touch) return;
        const previousY = press.lastY;
        press.lastY = touch.clientY;
        press.samples.push({ time: event.timeStamp, y: touch.clientY });
        if (press.samples.length > DETAILS_MOMENTUM_SAMPLE_LIMIT) press.samples.shift();

        const deltaY = touch.clientY - previousY;
        if (press.intent === "pending") {
          // 按住超过长按时长仍未锁轴：让位给卡片长按，不再参与调整。
          if (detailsResizePressIsHold(press.pressedAt, event.timeStamp)) {
            finishGesture(false, false);
            return;
          }
          press.intent = detailsResizeIntent(
            touch.clientX - press.startX,
            touch.clientY - press.startY,
          );
          if (press.intent === "pending") {
            claimPendingMove(
              event,
              press,
              touch.clientX - press.startX,
              touch.clientY - press.startY,
              deltaY,
            );
            return;
          }
        }
        if (press.intent === "swipe") {
          finishGesture(false, false);
          return;
        }
        if (!event.cancelable) {
          finishGesture(false, false);
          return;
        }
        if (!enabledRef.current) return;
        let gesture = gestureRef.current;
        if (!gesture) {
          const measured = geometryRef.current ?? initializeLayout();
          if (!measured?.layout) {
            finishGesture(false, false);
            return;
          }
          ensurePressScroll(press, viewport, true);
          const percent = currentPercentRef.current ?? measured.layout.initialPercent;
          const next = detailsContentScrollStep(
            percent,
            deltaY,
            press.scrollTop,
            measured.height,
            measured.layout.maxPercent,
            measured.layout.minPercent,
          );
          // 慢速滑过轴锁时，本帧即使只移动不到 1px 也要保留这次手势；
          // 只有占比完全不变（到边界或先消费内容滚动）才交还给原生滚动。
          if (Math.abs(next.percent - percent) < 1e-9) {
            finishGesture(false, false);
            return;
          }
          gesture = beginGesture(press, measured, {
            percent,
            scrollTop: press.scrollTop,
          });
        }
        if (!gesture) return;
        event.preventDefault();
        if (deltaY !== 0) {
          gesture.deltas.push(deltaY);
          frameQueueRef.current?.schedule();
        }
      };

      const end = (event: TouchEvent, cancel: boolean) => {
        const gesture = gestureRef.current;
        const press = pressRef.current;
        const touchId = gesture?.touchId ?? press?.touchId;
        if (touchId === undefined) return;
        const changed = Array.from(event.changedTouches).find(
          (item) => item.identifier === touchId,
        );
        if (!changed) return;

        if (!cancel && gesture) {
          frameQueueRef.current?.cancel();
          flushGesture(gesture);
        }
        let velocity = 0;
        if (!cancel && gesture && press) {
          velocity = detailsResizeVelocity(press.samples, event.timeStamp);
        }
        if (!cancel && gesture && Math.abs(velocity) >= DETAILS_MOMENTUM_MIN_VELOCITY) {
          gestureRef.current = null;
          pressRef.current = null;
          suppressClickUntilRef.current = Date.now() + DETAILS_RESIZE_TAP_SUPPRESSION_MS;
          startMomentum(
            velocity,
            gesture.cursor,
            gesture.scrollers,
            gesture.baseStageHeight,
            gesture.bounds,
          );
          return;
        }
        finishGesture(!cancel && Boolean(gesture), false);
      };

      const touchEnd = (event: TouchEvent) => end(event, false);
      const touchCancel = (event: TouchEvent) => end(event, true);
      const click = (event: MouseEvent) => {
        if (Date.now() >= suppressClickUntilRef.current) return;
        event.preventDefault();
        event.stopPropagation();
      };

      viewport.addEventListener("touchstart", start, { passive: true, capture: true });
      viewport.addEventListener("touchmove", move, { passive: false, capture: true });
      viewport.addEventListener("touchend", touchEnd, true);
      viewport.addEventListener("touchcancel", touchCancel, true);
      viewport.addEventListener("click", click, true);
      return () => {
        viewport.removeEventListener("touchstart", start, true);
        viewport.removeEventListener("touchmove", move, true);
        viewport.removeEventListener("touchend", touchEnd, true);
        viewport.removeEventListener("touchcancel", touchCancel, true);
        viewport.removeEventListener("click", click, true);
        finishGesture(false, false);
        stopMomentum(false);
        frameQueueRef.current?.cancel();
        clearDetailsLayout(containerRef.current);
      };
    },
    [
      beginGesture,
      containerRef,
      ensurePressScroll,
      finishGesture,
      flushGesture,
      initializeLayout,
      prepareResize,
      startMomentum,
      stopMomentum,
    ],
  );

  useLayoutEffect(() => {
    enabledRef.current = enabled;
    aspectRatioRef.current = aspectRatio;
    const reset = resetKeyRef.current !== resetKey;
    const aspectChanged = !Object.is(previousAspectRatioRef.current, aspectRatio);
    resetKeyRef.current = resetKey;
    previousAspectRatioRef.current = aspectRatio;

    if (reset || aspectChanged) {
      frameQueueRef.current?.cancel();
      finishGesture(false, false, !reset);
      stopMomentum(false);
      geometryRef.current = null;
      clearDetailsLayout(containerRef.current);
      if (pressRef.current) {
        pressRef.current.scrollers = null;
        pressRef.current.scrollTop = 0;
        pressRef.current.maxScrollTop = 0;
      }
      if (reset) {
        currentPercentRef.current = null;
        userAdjustedRef.current = false;
      } else if (!userAdjustedRef.current) {
        currentPercentRef.current = null;
      }
    }
    if (!enabled) {
      frameQueueRef.current?.cancel();
      finishGesture(false, false, true);
      stopMomentum(false);
      clearDetailsLayout(containerRef.current);
      return;
    }
    initializeLayout();
  }, [aspectRatio, containerRef, enabled, finishGesture, initializeLayout, resetKey, stopMomentum]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      const cached = geometryRef.current;
      if (
        cached &&
        Math.abs(cached.width - rect.width) < 0.5 &&
        Math.abs(cached.height - rect.height) < 0.5 &&
        Object.is(cached.aspectRatio, aspectRatioRef.current)
      ) {
        return;
      }
      frameQueueRef.current?.cancel();
      finishGesture(false, false, true);
      stopMomentum(false);
      geometryRef.current = null;
      initializeLayout(rect.width, rect.height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [aspectRatio, containerRef, enabled, finishGesture, initializeLayout, stopMomentum]);

  return bindContent;
}

/** 写入统一的侧栏占比；初始布局与拖动共用这个入口。 */
export function writeDetailsShare(container: HTMLElement | null, percent: number): void {
  if (!container) return;
  const value = detailsShareCssValue(roundDetailsShare(percent));
  setResizeStyle(container, detailsShareProperty, value);
  if (container.dataset.vodDetailsShare !== "true") {
    container.dataset.vodDetailsShare = "true";
  }
  syncResizeTargetState(container);
}

export function markDetailsResizing(container: HTMLElement | null, resizing: boolean): void {
  if (!container) return;
  if (resizing) {
    if (container.dataset.vodDetailsResizing !== "true") {
      container.dataset.vodDetailsResizing = "true";
    }
  } else {
    delete container.dataset.vodDetailsResizing;
  }
}

export function markDetailsPrepared(container: HTMLElement | null, prepared: boolean): void {
  if (!container) return;
  if (prepared) {
    if (container.dataset.vodDetailsPrepared !== "true") {
      container.dataset.vodDetailsPrepared = "true";
    }
  } else {
    delete container.dataset.vodDetailsPrepared;
  }
}

export function clearDetailsResizing(container: HTMLElement | null): void {
  markDetailsResizing(container, false);
}

export function clearDetailsLayout(container: HTMLElement | null): void {
  if (!container) return;
  delete container.dataset.vodDetailsShare;
  delete container.dataset.vodDetailsPrepared;
  delete container.dataset.vodDetailsResizing;
  container.style.removeProperty(detailsShareProperty);
  clearResizeTransform(container);
}
