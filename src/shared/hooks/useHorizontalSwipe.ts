import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  animate,
  type MotionStyle,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import {
  HORIZONTAL_SWIPE_CLICK_SUPPRESSION_MS,
  HORIZONTAL_SWIPE_DIRECTION_RATIO,
  HORIZONTAL_SWIPE_LOCK_DISTANCE_PX,
  HORIZONTAL_SWIPE_MAX_DRAG_PX,
  HORIZONTAL_SWIPE_PAGE_ENTRY_PX,
  horizontalSwipeDragOffset,
  isHorizontalSwipeIgnoredTarget,
  nextItemForHorizontalSwipe,
} from "@/shared/gestures/horizontalSwipe";
import { SPRING_SNAPPY } from "@/shared/motion/tokens";

type SwipeState = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffsetX: number;
  horizontal: boolean;
};

const HORIZONTAL_SWIPE_SURFACE_SELECTOR = "[data-horizontal-swipe-surface]";

export type UseHorizontalSwipeOptions<T> = {
  items: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** Enables touch swipe gestures. Defaults to true. */
  enabled?: boolean;
  /** Animates value changes regardless of gesture availability. Defaults to true. */
  animate?: boolean;
  isEqual?: (left: T, right: T) => boolean;
};

/**
 * Capture-phase pointer handlers that advance an ordered tab/platform strip.
 *
 * Capture is required on Android WebView: scrollable children (ScrollArea,
 * overflow lists) otherwise claim the gesture and the parent never sees
 * pointermove. `touch-action: pan-y` on the surface keeps vertical scrolling
 * native while leaving horizontal motion to this hook.
 */
export function useHorizontalSwipe<T>({
  items,
  value,
  onChange,
  enabled = true,
  animate: shouldAnimate = true,
  isEqual = Object.is,
}: UseHorizontalSwipeOptions<T>) {
  const swipeRef = useRef<SwipeState | null>(null);
  const clickSuppressionUntilRef = useRef(0);
  const pendingDirectionRef = useRef<1 | -1 | null>(null);
  const renderedValueRef = useRef(value);
  const itemsRef = useRef(items);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const isEqualRef = useRef(isEqual);
  const x = useMotionValue(0);
  const reducedMotion = useReducedMotion();
  const opacity = useTransform(
    x,
    [-HORIZONTAL_SWIPE_MAX_DRAG_PX, 0, HORIZONTAL_SWIPE_MAX_DRAG_PX],
    [0.9, 1, 0.9],
  );
  const motionStyle = useMemo<MotionStyle>(() => ({ x, opacity }), [opacity, x]);
  itemsRef.current = items;
  valueRef.current = value;
  onChangeRef.current = onChange;
  isEqualRef.current = isEqual;

  const settleAtRest = useCallback(() => {
    x.stop();
    if (reducedMotion) {
      x.jump(0);
      return;
    }
    // Direct pointer updates carry high instantaneous velocity. Reset it before
    // springing home so a short edge nudge cannot overshoot away from the page.
    x.jump(x.get());
    animate(x, 0, SPRING_SNAPPY);
  }, [reducedMotion, x]);

  useLayoutEffect(() => {
    const previousValue = renderedValueRef.current;
    if (isEqual(previousValue, value)) return;
    renderedValueRef.current = value;

    const previousIndex = items.findIndex((item) => isEqual(item, previousValue));
    const nextIndex = items.findIndex((item) => isEqual(item, value));
    const direction =
      pendingDirectionRef.current ??
      (previousIndex >= 0 && nextIndex >= 0 && previousIndex !== nextIndex
        ? nextIndex > previousIndex
          ? 1
          : -1
        : null);
    pendingDirectionRef.current = null;
    x.stop();

    if (!shouldAnimate || reducedMotion || direction === null) {
      x.jump(0);
      return;
    }

    // The old page followed the finger out. Before the browser paints the new
    // value, place it just across the opposite edge and settle it into view.
    x.jump(direction * HORIZONTAL_SWIPE_PAGE_ENTRY_PX);
    animate(x, 0, SPRING_SNAPPY);
  }, [isEqual, items, reducedMotion, shouldAnimate, value, x]);

  useLayoutEffect(() => {
    if (enabled) return;
    swipeRef.current = null;
    pendingDirectionRef.current = null;
    x.stop();
    x.jump(0);
  }, [enabled, x]);

  const releasePointer = useCallback((element: HTMLElement, pointerId: number) => {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }, []);

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Some Android WebViews report an empty pointerType for finger input.
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
      x.stop();
      swipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startOffsetX: x.get(),
        horizontal: false,
      };
    },
    [enabled, x],
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
          // Vertical list scroll owns this pointer.
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
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      if (!reducedMotion) {
        const currentIndex = itemsRef.current.findIndex((item) =>
          isEqualRef.current(item, valueRef.current),
        );
        const dragOffset = horizontalSwipeDragOffset(
          currentIndex,
          itemsRef.current.length,
          deltaX,
          event.currentTarget.clientWidth,
        );
        x.set(
          Math.max(
            -HORIZONTAL_SWIPE_MAX_DRAG_PX,
            Math.min(HORIZONTAL_SWIPE_MAX_DRAG_PX, swipe.startOffsetX + dragOffset),
          ),
        );
      }

      // Stop children (ScrollArea, buttons) from treating this as a drag/scroll.
      event.preventDefault();
      event.stopPropagation();
    },
    [reducedMotion, x],
  );

  const onPointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      swipeRef.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      if (!swipe.horizontal) return;

      const next = nextItemForHorizontalSwipe(
        itemsRef.current,
        valueRef.current,
        event.clientX - swipe.startX,
        event.clientY - swipe.startY,
        isEqualRef.current,
      );
      clickSuppressionUntilRef.current = Date.now() + HORIZONTAL_SWIPE_CLICK_SUPPRESSION_MS;
      event.preventDefault();
      event.stopPropagation();
      if (next === null) {
        settleAtRest();
        return;
      }

      const currentIndex = itemsRef.current.findIndex((item) =>
        isEqualRef.current(item, valueRef.current),
      );
      const nextIndex = itemsRef.current.findIndex((item) => isEqualRef.current(item, next));
      pendingDirectionRef.current = nextIndex > currentIndex ? 1 : -1;
      const previousValue = valueRef.current;
      onChangeRef.current(next);

      // Controlled values normally update in the same frame. If a caller
      // rejects or defers the change, do not leave the dragged page suspended.
      window.requestAnimationFrame(() => {
        if (
          pendingDirectionRef.current !== null &&
          isEqualRef.current(valueRef.current, previousValue)
        ) {
          pendingDirectionRef.current = null;
          settleAtRest();
        }
      });
    },
    [releasePointer, settleAtRest],
  );

  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      swipeRef.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      settleAtRest();
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
      motionStyle,
      onPointerDownCapture: undefined,
      onPointerMoveCapture: undefined,
      onPointerUpCapture: undefined,
      onPointerCancelCapture: undefined,
      onClickCapture: undefined,
    };
  }

  return {
    motionStyle,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onClickCapture,
  };
}
