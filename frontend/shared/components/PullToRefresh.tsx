import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useEffect,
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
  /** When true, pull tracking is disabled (for example during an in-flight refetch). */
  disabled?: boolean;
  /** External pending flag; combined with the component's own promise state. */
  refreshing?: boolean;
  children: ReactNode;
};

type PullState = {
  startX: number;
  startY: number;
  active: boolean;
};

/**
 * Touch pull-to-refresh for list pages.
 *
 * Uses non-passive capture touch listeners on the page scroller (`main`) so
 * Android WebView cannot steal the downward overscroll before JS runs. React
 * pointer handlers alone are not enough: the browser claims the gesture for
 * scrolling and never delivers preventDefault-capable move events.
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
  const pullRef = useRef<PullState | null>(null);
  const distanceRef = useRef(0);
  const [distance, setDistance] = useState(0);
  const [localRefreshing, setLocalRefreshing] = useState(false);
  // Parent often passes `false`; `??` would ignore localRefreshing. OR them.
  const refreshing = Boolean(refreshingProp) || localRefreshing;
  const disabledRef = useRef(disabled);
  const refreshingRef = useRef(refreshing);
  const onRefreshRef = useRef(onRefresh);
  disabledRef.current = disabled;
  refreshingRef.current = refreshing;
  onRefreshRef.current = onRefresh;

  const updateDistance = useCallback((next: number) => {
    distanceRef.current = next;
    setDistance(next);
  }, []);

  const triggerRefresh = useCallback(async () => {
    if (disabledRef.current || refreshingRef.current) {
      updateDistance(0);
      return;
    }
    setLocalRefreshing(true);
    updateDistance(PULL_TO_REFRESH_MAX_PX * 0.55);
    try {
      await onRefreshRef.current();
    } catch {
      // Queries and mutations own their visible error state/toast. The gesture
      // still needs to settle without leaking an unhandled rejection.
    } finally {
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

      // Non-passive listener: stop the page scroller from eating the overscroll.
      event.preventDefault();
      updateDistance(pullToRefreshDistance(deltaY));
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
    };
  }, [disabled, triggerRefresh, updateDistance]);

  const armed = isPullToRefreshArmed(distance) || refreshing;
  const indicatorOffset = refreshing ? Math.max(distance, 44) : distance;

  return (
    <div
      ref={rootRef}
      className={cn("relative min-h-full w-full touch-pan-y", className)}
      {...props}
    >
      <div
        aria-hidden={indicatorOffset <= 0}
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center transition-[opacity,transform] duration-150",
          indicatorOffset > 0 ? "opacity-100" : "opacity-0",
        )}
        style={{
          transform: `translateY(${Math.max(0, indicatorOffset - 36)}px)`,
        }}
      >
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-full border border-border-subtle bg-card/95 text-muted-foreground shadow-sm",
            armed && "border-primary/30 text-primary",
          )}
        >
          {refreshing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw
              className="size-4 transition-transform"
              style={{
                transform: `rotate(${Math.min(180, (distance / PULL_TO_REFRESH_MAX_PX) * 180)}deg)`,
              }}
              aria-hidden
            />
          )}
        </div>
      </div>
      <div
        className="flex min-h-full flex-col"
        style={
          indicatorOffset > 0 ? { transform: `translateY(${indicatorOffset * 0.35}px)` } : undefined
        }
      >
        {children}
      </div>
      {refreshing && <span className="sr-only">正在刷新</span>}
    </div>
  );
}
