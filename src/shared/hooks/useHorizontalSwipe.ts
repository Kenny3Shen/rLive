import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import {
  HORIZONTAL_SWIPE_CLICK_SUPPRESSION_MS,
  HORIZONTAL_SWIPE_DIRECTION_RATIO,
  HORIZONTAL_SWIPE_LOCK_DISTANCE_PX,
  HORIZONTAL_SWIPE_MAX_DRAG_PX,
  HORIZONTAL_SWIPE_VELOCITY_WINDOW_MS,
  type HorizontalSwipeSample,
  horizontalSwipeCommitOffset,
  horizontalSwipeDragOffset,
  horizontalSwipeSettleDuration,
  horizontalSwipeTargetItem,
  horizontalSwipeTrackOffset,
  horizontalSwipeVelocity,
  isHorizontalSwipeIgnoredTarget,
} from "@/shared/gestures/horizontalSwipe";
import { motionProfile, prefersReducedMotion, SWIPE_SETTLE_EASING } from "@/shared/motion/tokens";

type SwipeState = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  surfaceWidth: number;
  itemIndex: number;
  itemCount: number;
  reducedMotion: boolean;
  horizontal: boolean;
  /** 最近的指针位置序列，用于推导释放速度。 */
  samples: HorizontalSwipeSample[];
};

type HorizontalSwipeLayout = "page" | "track";

const HORIZONTAL_SWIPE_SURFACE_SELECTOR = "[data-horizontal-swipe-surface]";
/** 足以在任何现实指针频率下覆盖速度窗口的样本数。 */
const HORIZONTAL_SWIPE_MAX_SAMPLES = 8;
/**
 * 等待提交值到达的宽限期（ms）。
 *
 * 调用方合法地可能不在下一帧应用变更。React Router 的 `BrowserRouter` 把每次
 * location 更新包在 `startTransition` 里，触发导航的滑动 —— 平台条与关注过滤条
 * 都是，经由 search 参数 —— 会在一帧或多帧之后才提交，重量级路由上并发渲染
 * 可能更久。只有完全不应用该值的调用方才应该看到页面回到起点，所以窗口放宽：
 * 不必要的回滚是一次可见的向后跳动，而稍等片刻不可见 —— 页面本来就停在目的地上。
 */
const HORIZONTAL_SWIPE_COMMIT_GRACE_MS = 600;

function transformFor(offset: number): string {
  return `translate3d(${offset}px, 0, 0)`;
}

export type UseHorizontalSwipeOptions<T> = {
  items: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** 启用触摸滑动手势。默认 true。 */
  enabled?: boolean;
  /** 无论手势是否可用都对取值变化做动画。默认 true。 */
  animate?: boolean;
  /**
   * `track` 移动的是一个所有页面按 `index * width` 并排布局的层，
   * 邻居已经绘制完成，手势在真实页面之间平移。`page` 移动单个渲染页并依赖取值变化
   * 带入下一页，适用于邻居未挂载的条带。
   */
  layout?: HorizontalSwipeLayout;
  isEqual?: (left: T, right: T) => boolean;
};

/**
 * 有序页签/平台条的交互式翻页。
 *
 * Android WebView 上必须在捕获阶段处理指针事件：否则可滚动的子元素
 * （ScrollArea、overflow 列表）会认领手势，父级永远看不到 pointermove。
 * 表面上的 `touch-action: pan-y` 保持原生纵向滚动，横向运动交给本 hook。
 *
 * 把 `pageRef` 附着到应当移动的元素上。两个性质让过渡读作一次连续运动，
 * 而不是一次页面切换接一段动画：
 *
 * 1. 手指按下期间 transform 直接由 pointermove 处理器写入。把这些写入合并进
 * rAF 回调总会画出上一帧的指针位置，那正是"不跟手"的样子。
 * 2. 释放是 Web Animations transform，Chromium 在合成器上推进它。JS 补间库（以及
 * 任何 rAF ticker）必须与页面变更触发的 React 提交共享主线程 —— 重量级路由上
 * 那次提交长到能吞掉收尾的大部分帧，这正是已提交滑动曾看起来像瞬间切换接
 * 一段滑动的原因。
 *
 * 其时长与提交决策都来自手势本身：
 * 页面走过了多少表面，以及松手时手指有多快。
 */
export function useHorizontalSwipe<T>({
  items,
  value,
  onChange,
  enabled = true,
  animate: shouldAnimate = true,
  layout = "page",
  isEqual = Object.is,
}: UseHorizontalSwipeOptions<T>) {
  const isTrackLayout = layout === "track";
  const pageRef = useRef<HTMLElement | null>(null);
  const swipeRef = useRef<SwipeState | null>(null);
  const clickSuppressionUntilRef = useRef(0);
  const renderedValueRef = useRef(value);
  const itemsRef = useRef(items);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const isEqualRef = useRef(isEqual);
  // 最近观测到的表面宽度，使释放的滑动知道整页行程到底多远。
  // 也是跟手拖拽的上限。
  const surfaceWidthRef = useRef(0);
  const offsetRef = useRef(0);
  const animationRef = useRef<Animation | null>(null);
  const commitDeliveryFrameRef = useRef<number | null>(null);
  /** 在手势提交与其请求的取值变化之间设置。 */
  const pendingCommitRef = useRef<{ value: T; direction: 1 | -1; velocity: number } | null>(null);
  const commitRollbackTimerRef = useRef<number | null>(null);
  /** 监视 track 的视口。每个附着节点一个，重绑时替换。 */
  const trackResizeObserverRef = useRef<ResizeObserver | null>(null);
  itemsRef.current = items;
  valueRef.current = value;
  onChangeRef.current = onChange;
  isEqualRef.current = isEqual;

  const clearCommitRollback = useCallback(() => {
    if (commitRollbackTimerRef.current === null) return;
    window.clearTimeout(commitRollbackTimerRef.current);
    commitRollbackTimerRef.current = null;
  }, []);

  const clearCommitDelivery = useCallback(() => {
    if (commitDeliveryFrameRef.current === null) return;
    window.cancelAnimationFrame(commitDeliveryFrameRef.current);
    commitDeliveryFrameRef.current = null;
  }, []);

  const deliverCommittedChange = useCallback(
    (nextValue: T) => {
      clearCommitDelivery();
      if (!isTrackLayout) {
        onChangeRef.current(nextValue);
        return;
      }

      // 第一次 rAF 不含 React 工作，保证合成器能把释放动画画出来一次。取值变化在
      // 下一帧运行；即使挂载新平台开销很大，已经在跑的 Web Animation
      // 也会继续前进，而不是停在手指松开的位置。
      commitDeliveryFrameRef.current = window.requestAnimationFrame(() => {
        commitDeliveryFrameRef.current = window.requestAnimationFrame(() => {
          commitDeliveryFrameRef.current = null;
          onChangeRef.current(nextValue);
        });
      });
    },
    [clearCommitDelivery, isTrackLayout],
  );

  const surfaceWidth = useCallback(() => {
    const el = pageRef.current;
    // track 比它所处的视口更宽，因此测量的是裁剪它的父级。独立 page 位于带内边距
    // 的滚动容器内、比它平移经过的表面窄 —— 要测量手势表面本身，
    // 否则页面会以自身宽度进场并在边缘留下一条离场页的残影。
    const measured =
      (isTrackLayout
        ? el?.parentElement?.clientWidth
        : (el?.closest(HORIZONTAL_SWIPE_SURFACE_SELECTOR) ?? el)?.clientWidth) ?? 0;
    if (measured > 0) {
      surfaceWidthRef.current = measured;
      return measured;
    }
    return surfaceWidthRef.current;
  }, [isTrackLayout]);

  const restOffsetForIndex = useCallback(
    (index: number) => (isTrackLayout ? horizontalSwipeTrackOffset(index, surfaceWidth()) : 0),
    [isTrackLayout, surfaceWidth],
  );

  const restOffsetForValue = useCallback(
    (nextValue: T) => {
      if (!isTrackLayout) return 0;
      const index = itemsRef.current.findIndex((item) => isEqualRef.current(item, nextValue));
      return index >= 0 ? restOffsetForIndex(index) : 0;
    },
    [isTrackLayout, restOffsetForIndex],
  );

  /** 实际在屏上的偏移，包括仍在途中的收尾。 */
  const liveOffset = useCallback(() => {
    const el = pageRef.current;
    if (!el || !animationRef.current) return offsetRef.current;
    const computed = window.getComputedStyle(el).transform;
    if (!computed || computed === "none") return offsetRef.current;
    try {
      return new DOMMatrixReadOnly(computed).m41;
    } catch {
      return offsetRef.current;
    }
  }, []);

  const writeOffset = useCallback((offset: number) => {
    offsetRef.current = offset;
    const el = pageRef.current;
    if (el) el.style.transform = transformFor(offset);
  }, []);

  /** 在当前位置停止收尾，把该偏移留下作为内联样式。 */
  const cancelSettle = useCallback(() => {
    const animation = animationRef.current;
    if (!animation) return;
    const stoppedAt = liveOffset();
    animationRef.current = null;
    animation.cancel();
    writeOffset(stoppedAt);
  }, [liveOffset, writeOffset]);

  /**
   * 把剩余行程交给合成器。
   *
   * `fill: both` 使第一个关键帧在动画开始时立即生效，
   * 层在内联写入与动画接管之间绝不会绘制出未变换的帧。
   */
  const settle = useCallback(
    (target: number, duration: number) => {
      const el = pageRef.current;
      if (!el) return;
      cancelSettle();
      const from = offsetRef.current;
      // 独立 page 静止在 0，这也是它的自然布局位置：落到那里会整体去掉 transform，
      // 而不是让页面留在永久合成层上。track 的静止位置本身就是 transform。
      const restsUntransformed = !isTrackLayout && target === 0;
      if (duration <= 0 || from === target || prefersReducedMotion()) {
        offsetRef.current = target;
        el.style.transform = restsUntransformed ? "" : transformFor(target);
        el.style.willChange = "";
        return;
      }
      offsetRef.current = target;
      el.style.willChange = "transform";
      const animation = el.animate(
        [{ transform: transformFor(from) }, { transform: transformFor(target) }],
        { duration, easing: SWIPE_SETTLE_EASING, fill: "both" },
      );
      animationRef.current = animation;
      void animation.finished
        .then(() => {
          if (animationRef.current !== animation) return;
          animationRef.current = null;
          // 先写内联样式再移除动画效果：顺序颠倒会让部分 Android 合成器
          // 把未变换的层画出一帧。
          el.style.transform = restsUntransformed ? "" : transformFor(target);
          animation.cancel();
          el.style.willChange = "";
        })
        .catch(() => {
          // 新手势或新取值打断时预期会发生取消。
        });
    },
    [cancelSettle, isTrackLayout],
  );

  /** 把层停靠在其当前取值对应的偏移处，不做运动。 */
  const restAtValue = useCallback(() => {
    cancelSettle();
    const el = pageRef.current;
    const target = restOffsetForValue(valueRef.current);
    offsetRef.current = target;
    if (!el) return;
    el.style.willChange = "";
    // 收尾完成的独立 page 回到常规绘制，
    // 而不是保留一个永久合成层；track 的静止位置*就是* transform。
    if (isTrackLayout) el.style.transform = transformFor(target);
    else el.style.transform = "";
  }, [cancelSettle, isTrackLayout, restOffsetForValue]);

  /** 把手指留下的偏移归还给当前页面。 */
  const settleAtRest = useCallback(
    (velocity = 0) => {
      const target = restOffsetForValue(valueRef.current);
      settle(target, horizontalSwipeSettleDuration(target - offsetRef.current, velocity));
    },
    [restOffsetForValue, settle],
  );

  useLayoutEffect(() => {
    const previousValue = renderedValueRef.current;
    if (isEqual(previousValue, value)) return;
    renderedValueRef.current = value;

    const pendingCommit = pendingCommitRef.current;
    const committedByGesture = pendingCommit !== null && isEqual(pendingCommit.value, value);
    pendingCommitRef.current = null;
    clearCommitRollback();
    const el = pageRef.current;
    if (!el) return;

    // track 的页面按绝对下标定位，提交滑动不会移动其中任何一个：释放时开始的
    // 收尾正在驶向该取值的静止偏移，不要打扰它。
    if (isTrackLayout && committedByGesture) return;

    const previousIndex = items.findIndex((item) => isEqual(item, previousValue));
    const nextIndex = items.findIndex((item) => isEqual(item, value));
    const measuredSurfaceWidth = surfaceWidth();
    const profile = motionProfile();

    if (
      !shouldAnimate ||
      prefersReducedMotion() ||
      previousIndex < 0 ||
      nextIndex < 0 ||
      measuredSurfaceWidth <= 0
    ) {
      restAtValue();
      return;
    }

    if (isTrackLayout) {
      cancelSettle();
      // 只挂载了紧邻的页面，跨多步跳转会扫过不存在的页面。改为直接落位。
      if (Math.abs(nextIndex - previousIndex) !== 1) {
        restAtValue();
        return;
      }
      settle(restOffsetForIndex(nextIndex), profile.enter.duration * 1000);
      return;
    }

    // `page`：旧页跟着手指出去了，进入页此刻才存在。把它放到对面边缘之外一整个
    // 表面宽度处再收尾进来，使释放呈现为一次连续平移而不是短促追赶。
    const direction: 1 | -1 = pendingCommit?.direction ?? (nextIndex > previousIndex ? 1 : -1);
    cancelSettle();
    const startOffset = horizontalSwipeCommitOffset(
      pendingCommit === null ? 0 : offsetRef.current,
      direction,
      measuredSurfaceWidth,
    );
    writeOffset(startOffset);
    settle(
      0,
      pendingCommit === null
        ? profile.enter.duration * 1000
        : horizontalSwipeSettleDuration(startOffset, pendingCommit.velocity),
    );
  }, [
    cancelSettle,
    clearCommitRollback,
    isEqual,
    isTrackLayout,
    items,
    restAtValue,
    restOffsetForIndex,
    settle,
    shouldAnimate,
    surfaceWidth,
    value,
    writeOffset,
  ]);

  const disconnectTrackResize = useCallback(() => {
    const observer = trackResizeObserverRef.current;
    if (!observer) return;
    trackResizeObserverRef.current = null;
    observer.disconnect();
  }, []);

  /**
   * 把 track 停靠在其当前取值对应的偏移处，并持续测量它所在的视口。
   *
   * 定位 track 属于布局而不是手势，因此在没有触摸的客户端上也会运行：
   * 即使指针永远不会到来，条带也必须显示选中的页面。
   *
   * 挂载时*和*每次重绑时都运行，因为 hook 保持挂载期间调用方可能替换 track。
   * Shell 的 `PagePan` 以 pathname 为 key，离开可滑动路由再回来会重建整个
   * 视口/track/面板子树 —— 而赋值 ref 不会重跑布局副作用，
   * 只在挂载时停靠的话新 track 保持未变换，而 `offsetRef` 还握着 `-index * width`。
   * 面板位于其*绝对*条带下标，于是第一页之后的任何页面都会把活动面板整个推出
   * 屏幕：手指下方没有任何可滚动内容，而一次横向手势的提交只会重新挂载页面。
   *
   * 独立的 `page` 完全不需要这些：它未变换地停在偏移 0，
   * 新挂载的节点本来就在那里。
   */
  const parkTrack = useCallback(() => {
    disconnectTrackResize();
    if (!isTrackLayout) return;
    const el = pageRef.current;
    const viewport = el?.parentElement;
    if (!el || !viewport) return;

    const applyWidth = () => {
      const width = viewport.clientWidth;
      // 手势中途偏移归手指所有；此时的 resize 是键盘或系统栏出现，
      // 在指针下方重建基准会跳动。
      if (width <= 0 || swipeRef.current?.horizontal) return;
      surfaceWidthRef.current = width;
      const index = itemsRef.current.findIndex((item) =>
        isEqualRef.current(item, valueRef.current),
      );
      if (index < 0) return;
      cancelSettle();
      writeOffset(horizontalSwipeTrackOffset(index, width));
    };

    // 观察即使在手势中途也会发生 —— `applyWidth` 自行判断是否可以移动层 ——
    // 因此手指按下时绑定的 track 不会被永久留在未测量状态。
    applyWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(applyWidth);
    trackResizeObserverRef.current = observer;
    observer.observe(viewport);
  }, [cancelSettle, disconnectTrackResize, isTrackLayout, writeOffset]);

  /**
   * 附着应当移动的元素。这是唯一入口：特意用回调 ref 而不是 ref 对象，
   * 正是为了替换表面不可能不被察觉。
   *
   * 它的身份随 `layout` 变化，因此节点或布局任一变化时 React 都会重新调用它 ——
   * `parkTrack` 随之再跑 —— 且仅在这些时刻。手势提交不动节点，
   * 它开始的收尾绝不会被中断。
   */
  const bindPage = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      pageRef.current = node;
      parkTrack();
      return () => {
        // 被保留的离场动画（PagePan 让离场页继续存活）意味着本次清理可能在更新的
        // 表面已经绑定并被观察时运行。只有仍在负责的节点才能拆除任何东西。
        if (pageRef.current !== node) return;
        disconnectTrackResize();
        pageRef.current = null;
      };
    },
    [disconnectTrackResize, parkTrack],
  );

  useLayoutEffect(() => {
    if (enabled) return;
    swipeRef.current = null;
    pendingCommitRef.current = null;
    clearCommitDelivery();
    clearCommitRollback();
    restAtValue();
  }, [clearCommitDelivery, clearCommitRollback, enabled, restAtValue]);

  // 表面消失时丢弃一切仍在途的东西，
  // 使没有动画对着已分离的节点 tick、没有计时器打进已卸载的 hook。
  useLayoutEffect(
    () => () => {
      clearCommitDelivery();
      clearCommitRollback();
      const animation = animationRef.current;
      animationRef.current = null;
      animation?.cancel();
      const el = pageRef.current;
      if (el) {
        el.style.transform = "";
        el.style.willChange = "";
      }
    },
    [clearCommitDelivery, clearCommitRollback],
  );

  const releasePointer = useCallback((element: HTMLElement, pointerId: number) => {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }, []);

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // 部分 Android WebView 对手指输入上报空的 pointerType。
      const pointerType = event.pointerType as string;
      const target = event.target instanceof Element ? event.target : null;
      const nearestSwipeSurface = target?.closest(HORIZONTAL_SWIPE_SURFACE_SELECTOR);
      if (
        !enabled ||
        (pointerType !== "touch" && pointerType !== "") ||
        !event.isPrimary ||
        (nearestSwipeSurface !== null && nearestSwipeSurface !== event.currentTarget) ||
        isHorizontalSwipeIgnoredTarget(event.target)
      ) {
        return;
      }
      const measured = surfaceWidth();
      const nextSurfaceWidth = measured > 0 ? measured : event.currentTarget.clientWidth;
      const currentItems = itemsRef.current;
      swipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        // 临时值：收尾可能仍在运行，其达到的偏移只到手势锁定为横向时才读取。
        startOffset: offsetRef.current,
        surfaceWidth: nextSurfaceWidth,
        itemIndex: currentItems.findIndex((item) => isEqualRef.current(item, valueRef.current)),
        itemCount: currentItems.length,
        reducedMotion: prefersReducedMotion(),
        horizontal: false,
        samples: [{ x: event.clientX, time: performance.now() }],
      };
      surfaceWidthRef.current = nextSurfaceWidth;
    },
    [enabled, surfaceWidth],
  );

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - swipe.startX;
      const deltaY = event.clientY - swipe.startY;
      const horizontalDistance = Math.abs(deltaX);
      const verticalDistance = Math.abs(deltaY);

      if (!swipe.horizontal) {
        if (
          verticalDistance >= HORIZONTAL_SWIPE_LOCK_DISTANCE_PX &&
          verticalDistance >= horizontalDistance
        ) {
          // 纵向列表滚动拥有这个指针。
          swipeRef.current = null;
          return;
        }
        if (
          horizontalDistance < HORIZONTAL_SWIPE_LOCK_DISTANCE_PX ||
          horizontalDistance <= verticalDistance * HORIZONTAL_SWIPE_DIRECTION_RATIO
        ) {
          return;
        }
        swipe.horizontal = true;
        const el = pageRef.current;
        if (el) {
          // 从收尾到达的精确像素接管，使过渡中途抓住页面从那里继续而不是跳变。
          cancelSettle();
          swipe.startOffset = offsetRef.current;
          // 只有在确认手势为横向后才提升层；
          // 纵向滚动绝不能提升整个滚动页面。
          el.style.willChange = "transform";
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        // 从锁定点重启采样：锁定前的样本描述的是尚未被识别为翻页的手势。
        swipe.samples = [];
      }

      swipe.samples.push({ x: event.clientX, time: performance.now() });
      if (swipe.samples.length > HORIZONTAL_SWIPE_MAX_SAMPLES) swipe.samples.shift();

      if (!swipe.reducedMotion) {
        const width = swipe.surfaceWidth;
        const dragOffset = horizontalSwipeDragOffset(
          swipe.itemIndex,
          swipe.itemCount,
          deltaX,
          width,
        );
        const nextOffset = swipe.startOffset + dragOffset;
        if (isTrackLayout) {
          // track 的偏移每页累积一整个宽度。把绝对偏移钳制到一个宽度会让第二页之后的
          // 所有页面冻住。`horizontalSwipeDragOffset` 已经限制了本手势自身的增量
          // 并在首尾页阻尼。
          writeOffset(nextOffset);
        } else {
          const bound = width > 0 ? width : HORIZONTAL_SWIPE_MAX_DRAG_PX;
          writeOffset(Math.max(-bound, Math.min(bound, nextOffset)));
        }
      }

      // 阻止子元素（ScrollArea、按钮）把这当作拖拽/滚动。
      event.preventDefault();
      event.stopPropagation();
    },
    [cancelSettle, isTrackLayout, writeOffset],
  );

  const onPointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      swipeRef.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      if (!swipe.horizontal) return;

      swipe.samples.push({ x: event.clientX, time: performance.now() });
      const velocity = horizontalSwipeVelocity(swipe.samples, HORIZONTAL_SWIPE_VELOCITY_WINDOW_MS);
      const dragOffset = offsetRef.current - swipe.startOffset;
      const next = horizontalSwipeTargetItem(
        itemsRef.current,
        valueRef.current,
        dragOffset,
        velocity,
        swipe.surfaceWidth,
        isEqualRef.current,
      );
      clickSuppressionUntilRef.current = Date.now() + HORIZONTAL_SWIPE_CLICK_SUPPRESSION_MS;
      event.preventDefault();
      event.stopPropagation();
      if (next === null) {
        settleAtRest(velocity);
        return;
      }

      const currentIndex = itemsRef.current.findIndex((item) =>
        isEqualRef.current(item, valueRef.current),
      );
      const nextIndex = itemsRef.current.findIndex((item) => isEqualRef.current(item, next));
      const previousValue = valueRef.current;
      pendingCommitRef.current = {
        value: next,
        direction: nextIndex > currentIndex ? 1 : -1,
        velocity,
      };

      // 先开始收尾再通知 React，保持这个顺序。track 的页面按绝对下标定位，
      // 提交不会移动动画关心的任何东西 —— 若反过来等取值变化先行，
      // 整个 React 提交就会插在手指抬起与第一个动画帧之间。
      if (isTrackLayout) {
        const target = restOffsetForIndex(nextIndex);
        settle(target, horizontalSwipeSettleDuration(target - offsetRef.current, velocity));
      }
      deliverCommittedChange(next);

      // 彻底拒绝变更的调用方的最后兜底，使页面不会停在两页之间。刻意用计时器而不是
      // 下一帧：经由过渡送达的取值合法地需要好几帧，
      // 在它落地前回滚会撤销已经在运行的收尾。
      clearCommitRollback();
      commitRollbackTimerRef.current = window.setTimeout(() => {
        commitRollbackTimerRef.current = null;
        if (
          pendingCommitRef.current !== null &&
          isEqualRef.current(valueRef.current, previousValue)
        ) {
          pendingCommitRef.current = null;
          settleAtRest();
        }
      }, HORIZONTAL_SWIPE_COMMIT_GRACE_MS);
    },
    [
      clearCommitRollback,
      deliverCommittedChange,
      isTrackLayout,
      releasePointer,
      restOffsetForIndex,
      settle,
      settleAtRest,
    ],
  );

  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      swipeRef.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      if (swipe.horizontal) settleAtRest();
    },
    [releasePointer, settleAtRest],
  );

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (Date.now() >= clickSuppressionUntilRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  if (!enabled) {
    return {
      bindPage,
      onPointerDownCapture: undefined,
      onPointerMoveCapture: undefined,
      onPointerUpCapture: undefined,
      onPointerCancelCapture: undefined,
      onClickCapture: undefined,
    };
  }

  return {
    bindPage,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onClickCapture,
  };
}
