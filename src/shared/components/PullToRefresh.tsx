import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  canStartPullToRefresh,
  findVerticalScrollParent,
  isPullToRefreshArmed,
  isPullToRefreshGesture,
  pullToRefreshDistance,
  PULL_TO_REFRESH_MAX_PX,
} from "@/shared/gestures/pullToRefresh";
import { isHorizontalSwipeIgnoredTarget } from "@/shared/gestures/horizontalSwipe";
import { cn } from "@/lib/utils";

type PullToRefreshProps = Omit<ComponentPropsWithoutRef<"div">, "onRefresh"> & {
  onRefresh: () => void | Promise<unknown>;
  /** 为 true 时禁用下拉跟踪（例如刷新请求在途期间）。 */
  disabled?: boolean;
  /** 外部 pending 标志；与组件自身的 promise 状态合并。 */
  refreshing?: boolean;
  children: ReactNode;
};

type PullState = {
  startX: number;
  startY: number;
  active: boolean;
};

/**
 * 列表页的触摸下拉刷新。
 *
 * 在页面滚动容器（`main`）上使用非 passive 的捕获阶段 touch 监听器，
 * 使 Android WebView 无法在 JS 运行之前抢走向下的过度滚动。仅靠 React 指针
 * 处理器不够：浏览器会把该手势认领给滚动，
 * 永远不会派发可 preventDefault 的 move 事件。
 */
export function PullToRefresh({
  onRefresh,
  disabled = false,
  refreshing: refreshingProp = false,
  className,
  children,
  ...props
}: PullToRefreshProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const indicatorBodyRef = useRef<HTMLDivElement | null>(null);
  const refreshIconRef = useRef<SVGSVGElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pullRef = useRef<PullState | null>(null);
  const distanceRef = useRef(0);
  const pendingDistanceRef = useRef(0);
  const pendingDraggingRef = useRef(false);
  const distanceFrameRef = useRef<number | null>(null);
  const [localRefreshing, setLocalRefreshing] = useState(false);
  // 父组件常传 `false`；`??` 会忽略 localRefreshing。改用 OR。
  const refreshing = Boolean(refreshingProp) || localRefreshing;
  const disabledRef = useRef(disabled);
  const refreshingRef = useRef(refreshing);
  const refreshingPropRef = useRef(Boolean(refreshingProp));
  const onRefreshRef = useRef(onRefresh);
  disabledRef.current = disabled;
  refreshingRef.current = refreshing;
  refreshingPropRef.current = Boolean(refreshingProp);
  onRefreshRef.current = onRefresh;

  const applyDistance = useCallback((distance: number, dragging: boolean) => {
    const indicator = indicatorRef.current;
    const indicatorBody = indicatorBodyRef.current;
    const refreshIcon = refreshIconRef.current;
    const content = contentRef.current;
    const isRefreshing = refreshingRef.current;
    const indicatorOffset = isRefreshing ? Math.max(distance, 44) : distance;
    const transitionDuration = dragging ? "0ms" : "";

    if (indicator) {
      indicator.style.transitionDuration = transitionDuration;
      indicator.style.opacity = indicatorOffset > 0 ? "1" : "0";
      indicator.style.transform = `translate3d(0, ${Math.max(0, indicatorOffset - 36)}px, 0)`;
      indicator.setAttribute("aria-hidden", indicatorOffset > 0 ? "false" : "true");
    }
    if (indicatorBody) {
      indicatorBody.dataset.armed =
        isRefreshing || isPullToRefreshArmed(distance) ? "true" : "false";
    }
    if (refreshIcon) {
      refreshIcon.style.transitionDuration = transitionDuration;
      refreshIcon.style.transform = `rotate(${Math.min(
        180,
        (distance / PULL_TO_REFRESH_MAX_PX) * 180,
      )}deg)`;
    }
    if (content) {
      content.style.transitionDuration = transitionDuration;
      content.style.transform =
        indicatorOffset > 0 ? `translate3d(0, ${indicatorOffset * 0.35}px, 0)` : "";
    }
  }, []);

  const flushDistanceWrite = useCallback(() => {
    distanceFrameRef.current = null;
    applyDistance(pendingDistanceRef.current, pendingDraggingRef.current);
  }, [applyDistance]);

  const updateDistance = useCallback(
    (next: number, dragging = false) => {
      distanceRef.current = next;
      pendingDistanceRef.current = next;
      pendingDraggingRef.current = dragging;
      if (distanceFrameRef.current === null) {
        distanceFrameRef.current = window.requestAnimationFrame(flushDistanceWrite);
      }
    },
    [flushDistanceWrite],
  );

  const cancelDistanceWrite = useCallback(() => {
    if (distanceFrameRef.current !== null) {
      window.cancelAnimationFrame(distanceFrameRef.current);
      distanceFrameRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    // React 把空闲箭头换成加载图标之后重新应用，
    // 同时不把高频拖拽距离放回组件状态。
    applyDistance(distanceRef.current, false);
  }, [applyDistance, refreshing]);

  const triggerRefresh = useCallback(async () => {
    if (disabledRef.current || refreshingRef.current) {
      updateDistance(0);
      return;
    }
    refreshingRef.current = true;
    setLocalRefreshing(true);
    updateDistance(PULL_TO_REFRESH_MAX_PX * 0.55);
    try {
      await onRefreshRef.current();
    } catch {
      // 查询与变更拥有各自的可见错误状态/toast。手势仍需正常收尾，
      // 且不泄漏未处理的 rejection。
    } finally {
      refreshingRef.current = refreshingPropRef.current;
      setLocalRefreshing(false);
      updateDistance(0);
      pullRef.current = null;
    }
  }, [updateDistance]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || disabled) return;

    const scrollParent = findVerticalScrollParent(root) ?? root;

    const onTouchStart = (event: TouchEvent) => {
      if (disabledRef.current || refreshingRef.current) return;
      if (event.touches.length !== 1) return;
      if (isHorizontalSwipeIgnoredTarget(event.target)) return;
      if (!canStartPullToRefresh(scrollParent.scrollTop)) return;

      const touch = event.touches[0];
      if (!touch) return;
      pullRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: false,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      const pull = pullRef.current;
      if (!pull || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - pull.startX;
      const deltaY = touch.clientY - pull.startY;

      if (!pull.active) {
        if (deltaY <= 0) return;
        if (!canStartPullToRefresh(scrollParent.scrollTop)) {
          pullRef.current = null;
          return;
        }
        if (!isPullToRefreshGesture(deltaX, deltaY)) {
          if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) >= 10) {
            pullRef.current = null;
          }
          return;
        }
        pull.active = true;
      }

      // 非 passive 监听器：阻止页面滚动容器吞掉过度滚动。
      event.preventDefault();
      updateDistance(pullToRefreshDistance(deltaY), true);
    };

    const onTouchEnd = () => {
      const pull = pullRef.current;
      if (!pull) return;
      const armed = pull.active && isPullToRefreshArmed(distanceRef.current);
      pullRef.current = null;
      if (armed) {
        void triggerRefresh();
        return;
      }
      updateDistance(0);
    };

    const onTouchCancel = () => {
      pullRef.current = null;
      updateDistance(0);
    };

    scrollParent.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    scrollParent.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    scrollParent.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    scrollParent.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });

    return () => {
      scrollParent.removeEventListener("touchstart", onTouchStart, true);
      scrollParent.removeEventListener("touchmove", onTouchMove, true);
      scrollParent.removeEventListener("touchend", onTouchEnd, true);
      scrollParent.removeEventListener("touchcancel", onTouchCancel, true);
      pullRef.current = null;
      cancelDistanceWrite();
      distanceRef.current = 0;
      pendingDistanceRef.current = 0;
      applyDistance(0, false);
    };
  }, [applyDistance, cancelDistanceWrite, disabled, triggerRefresh, updateDistance]);

  return (
    <div
      ref={rootRef}
      className={cn("relative min-h-full w-full touch-pan-y", className)}
      {...props}
    >
      <div
        ref={indicatorRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center opacity-0 transition-[opacity,transform] duration-150 ease-out motion-reduced:transition-none"
      >
        <div
          ref={indicatorBodyRef}
          data-armed={refreshing ? "true" : "false"}
          className="flex size-9 items-center justify-center rounded-full border border-border-subtle bg-card/95 text-muted-foreground shadow-sm data-[armed=true]:border-primary/30 data-[armed=true]:text-primary"
        >
          {refreshing ? (
            <Loader2 className="size-4 animate-spin motion-reduced:animate-none" aria-hidden />
          ) : (
            <RefreshCw
              ref={refreshIconRef}
              className="size-4 transition-transform duration-150 ease-out motion-reduced:transition-none"
              aria-hidden
            />
          )}
        </div>
      </div>
      <div
        ref={contentRef}
        className="flex min-h-full flex-col transition-transform duration-150 ease-out motion-reduced:transition-none"
      >
        {children}
      </div>
      {refreshing && <span className="sr-only">正在刷新</span>}
    </div>
  );
}
