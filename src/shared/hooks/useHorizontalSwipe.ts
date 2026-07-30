import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
} from "react";
import {
  HORIZONTAL_SWIPE_CLICK_SUPPRESSION_MS,
  HORIZONTAL_SWIPE_DIRECTION_RATIO,
  HORIZONTAL_SWIPE_LOCK_DISTANCE_PX,
  isHorizontalSwipeIgnoredTarget,
  nextItemForHorizontalSwipe,
} from "@/shared/gestures/horizontalSwipe";

type SwipeState = {
  pointerId: number;
  startX: number;
  startY: number;
  horizontal: boolean;
};

export type UseHorizontalSwipeOptions<T> = {
  items: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** Defaults to true. Disable on desktop mouse layouts when desired. */
  enabled?: boolean;
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
  isEqual = Object.is,
}: UseHorizontalSwipeOptions<T>) {
  const swipeRef = useRef<SwipeState | null>(null);
  const clickSuppressionUntilRef = useRef(0);
  const itemsRef = useRef(items);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const isEqualRef = useRef(isEqual);
  itemsRef.current = items;
  valueRef.current = value;
  onChangeRef.current = onChange;
  isEqualRef.current = isEqual;

  const releasePointer = useCallback((element: HTMLElement, pointerId: number) => {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }, []);

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Some Android WebViews report an empty pointerType for finger input.
      const pointerType = event.pointerType as string;
      if (
        !enabled ||
        (pointerType !== "touch" && pointerType !== "") ||
        !event.isPrimary ||
        isHorizontalSwipeIgnoredTarget(event.target)
      ) {
        return;
      }
      swipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        horizontal: false,
      };
    },
    [enabled],
  );

  const onPointerMoveCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
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

    // Stop children (ScrollArea, buttons) from treating this as a drag/scroll.
    event.preventDefault();
    event.stopPropagation();
  }, []);

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
      if (next === null) return;
      onChangeRef.current(next);
    },
    [releasePointer],
  );

  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      swipeRef.current = null;
      releasePointer(event.currentTarget, event.pointerId);
    },
    [releasePointer],
  );

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (Date.now() >= clickSuppressionUntilRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  if (!enabled) {
    return {
      onPointerDownCapture: undefined,
      onPointerMoveCapture: undefined,
      onPointerUpCapture: undefined,
      onPointerCancelCapture: undefined,
      onClickCapture: undefined,
    };
  }

  return {
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onClickCapture,
  };
}
