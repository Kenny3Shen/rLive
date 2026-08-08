import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import gsap from "gsap";
import {
  HORIZONTAL_SWIPE_CLICK_SUPPRESSION_MS,
  HORIZONTAL_SWIPE_DIRECTION_RATIO,
  HORIZONTAL_SWIPE_LOCK_DISTANCE_PX,
  HORIZONTAL_SWIPE_MAX_DRAG_PX,
  horizontalSwipeCommitOffset,
  horizontalSwipeDragOffset,
  horizontalSwipeTrackOffset,
  isHorizontalSwipeIgnoredTarget,
  nextItemForHorizontalSwipe,
} from "@/shared/gestures/horizontalSwipe";
import { prefersReducedMotion, SWIPE_SETTLE } from "@/shared/motion/tokens";

type SwipeState = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffsetX: number;
  surfaceWidth: number;
  itemIndex: number;
  itemCount: number;
  reducedMotion: boolean;
  horizontal: boolean;
};

type SwipeOffsetSetter = (value: number) => void;
type HorizontalSwipeLayout = "page" | "track";

const HORIZONTAL_SWIPE_SURFACE_SELECTOR = "[data-horizontal-swipe-surface]";

export type UseHorizontalSwipeOptions<T> = {
  items: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** Enables touch swipe gestures. Defaults to true. */
  enabled?: boolean;
  /** Animates value changes regardless of gesture availability. Defaults to true. */
  animate?: boolean;
  /**
   * `page` moves one currently rendered page; `track` moves an equal-width row
   * whose children stay mounted side by side during the gesture.
   */
  layout?: HorizontalSwipeLayout;
  isEqual?: (left: T, right: T) => boolean;
};

/**
 * Capture-phase pointer handlers that advance an ordered tab/platform strip.
 *
 * Capture is required on Android WebView: scrollable children (ScrollArea,
 * overflow lists) otherwise claim the gesture and the parent never sees
 * pointermove. `touch-action: pan-y` on the surface keeps vertical scrolling
 * native while leaving horizontal motion to this hook.
 *
 * Attach `pageRef` to the element that should travel. While a finger is down the
 * offset is written through one reused `gsap.quickSetter`, so pointermove never
 * allocates a tween. A tween is created only when the page settles back to rest
 * or the committed page pans into place.
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
  const pendingDirectionRef = useRef<1 | -1 | null>(null);
  const renderedValueRef = useRef(value);
  const itemsRef = useRef(items);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const isEqualRef = useRef(isEqual);
  // Last observed surface width, so a committed swipe knows how far a full-width
  // pan actually is. Also the cap for the follow-the-finger drag.
  const surfaceWidthRef = useRef(0);
  const offsetRef = useRef(0);
  const pendingOffsetRef = useRef<number | null>(null);
  const offsetFrameRef = useRef<number | null>(null);
  const offsetSetterRef = useRef<SwipeOffsetSetter | null>(null);
  const offsetSetterElementRef = useRef<HTMLElement | null>(null);
  itemsRef.current = items;
  valueRef.current = value;
  onChangeRef.current = onChange;
  isEqualRef.current = isEqual;

  const flushOffset = useCallback(() => {
    offsetFrameRef.current = null;
    const next = pendingOffsetRef.current;
    pendingOffsetRef.current = null;
    const el = pageRef.current;
    if (!el || next === null) return;
    if (!offsetSetterRef.current || offsetSetterElementRef.current !== el) {
      offsetSetterElementRef.current = el;
      offsetSetterRef.current = gsap.quickSetter(el, "x", "px") as SwipeOffsetSetter;
    }
    offsetSetterRef.current(next);
  }, []);

  const cancelPendingOffset = useCallback(() => {
    if (offsetFrameRef.current !== null) {
      window.cancelAnimationFrame(offsetFrameRef.current);
      offsetFrameRef.current = null;
    }
    pendingOffsetRef.current = null;
  }, []);

  const flushPendingOffset = useCallback(() => {
    if (offsetFrameRef.current !== null) {
      window.cancelAnimationFrame(offsetFrameRef.current);
      offsetFrameRef.current = null;
    }
    flushOffset();
  }, [flushOffset]);

  const surfaceWidth = useCallback(() => {
    const track = pageRef.current;
    const measured = track?.parentElement?.clientWidth ?? 0;
    if (measured > 0) {
      surfaceWidthRef.current = measured;
      return measured;
    }
    return surfaceWidthRef.current;
  }, []);

  const settledOffsetForValue = useCallback(
    (nextValue: T) => {
      if (!isTrackLayout) return 0;
      const index = itemsRef.current.findIndex((item) => isEqualRef.current(item, nextValue));
      return index >= 0 ? horizontalSwipeTrackOffset(index, surfaceWidth()) : 0;
    },
    [isTrackLayout, surfaceWidth],
  );

  /** Coalesce high-polling pointer events into one compositor write per frame. */
  const setOffset = useCallback(
    (next: number) => {
      offsetRef.current = next;
      pendingOffsetRef.current = next;
      if (offsetFrameRef.current === null) {
        offsetFrameRef.current = window.requestAnimationFrame(flushOffset);
      }
    },
    [flushOffset],
  );

  /** Return the settled page to normal layout painting instead of a permanent layer. */
  const clearOffset = useCallback(() => {
    cancelPendingOffset();
    offsetSetterRef.current = null;
    offsetSetterElementRef.current = null;
    const el = pageRef.current;
    const settledOffset = settledOffsetForValue(valueRef.current);
    offsetRef.current = settledOffset;
    if (!el) return;
    if (isTrackLayout) {
      gsap.set(el, { x: settledOffset, clearProps: "willChange" });
    } else {
      gsap.set(el, { clearProps: "transform,willChange" });
    }
  }, [cancelPendingOffset, isTrackLayout, settledOffsetForValue]);

  /** Tween whatever offset the finger left behind back to rest. */
  const settleAtRest = useCallback(() => {
    const el = pageRef.current;
    if (!el) return;
    flushPendingOffset();
    gsap.killTweensOf(el);
    const targetOffset = settledOffsetForValue(valueRef.current);
    if (prefersReducedMotion()) {
      clearOffset();
      return;
    }
    offsetRef.current = targetOffset;
    gsap.to(el, {
      x: targetOffset,
      ...SWIPE_SETTLE,
      // The compositor hint is only worth carrying while something moves.
      onComplete: clearOffset,
    });
  }, [clearOffset, flushPendingOffset, settledOffsetForValue]);

  useLayoutEffect(() => {
    const previousValue = renderedValueRef.current;
    if (isEqual(previousValue, value)) return;
    renderedValueRef.current = value;

    const previousIndex = items.findIndex((item) => isEqual(item, previousValue));
    const nextIndex = items.findIndex((item) => isEqual(item, value));
    const pendingDirection = pendingDirectionRef.current;
    const direction =
      pendingDirection ??
      (previousIndex >= 0 && nextIndex >= 0 && previousIndex !== nextIndex
        ? nextIndex > previousIndex
          ? 1
          : -1
        : null);
    pendingDirectionRef.current = null;
    const el = pageRef.current;
    if (!el) return;
    cancelPendingOffset();
    gsap.killTweensOf(el);

    // `shouldAnimate: false` means a parent PagePan owns the entry pan. Land at
    // rest immediately: this element is shared by the outgoing and incoming
    // pages, so any offset left here would ride on top of the parent's travel
    // and leave a band of the old page on screen.
    if (!shouldAnimate || prefersReducedMotion() || direction === null) {
      clearOffset();
      return;
    }

    const measuredSurfaceWidth = isTrackLayout ? surfaceWidth() : surfaceWidthRef.current;
    if (measuredSurfaceWidth <= 0) {
      clearOffset();
      return;
    }

    if (isTrackLayout) {
      // All pages stay mounted in the track, so the release only needs to settle
      // the row at the newly selected page. The outgoing and incoming panels
      // have already been visible together while the finger was moving.
      const targetOffset = horizontalSwipeTrackOffset(nextIndex, measuredSurfaceWidth);
      gsap.to(el, {
        x: targetOffset,
        force3D: true,
        ...SWIPE_SETTLE,
        onComplete: clearOffset,
      });
      offsetRef.current = targetOffset;
      return;
    }

    // The old page followed the finger out. Before the browser paints the new
    // value, place the incoming page a full surface width across the opposite
    // edge and settle it in, so the release plays as one continuous pan rather
    // than a short catch-up nudge.
    const startOffset = horizontalSwipeCommitOffset(
      pendingDirection === null ? 0 : offsetRef.current,
      direction,
      measuredSurfaceWidth,
    );
    gsap.fromTo(
      el,
      { x: startOffset, force3D: true, willChange: "transform" },
      {
        x: 0,
        force3D: true,
        ...SWIPE_SETTLE,
        onComplete: clearOffset,
      },
    );
    offsetRef.current = 0;
  }, [
    cancelPendingOffset,
    clearOffset,
    isEqual,
    isTrackLayout,
    items,
    shouldAnimate,
    surfaceWidth,
    value,
  ]);

  useLayoutEffect(() => {
    if (!enabled || !isTrackLayout) return;
    const el = pageRef.current;
    const width = surfaceWidth();
    if (!el || width <= 0) return;
    const index = itemsRef.current.findIndex((item) => isEqualRef.current(item, valueRef.current));
    if (index < 0) return;
    const targetOffset = horizontalSwipeTrackOffset(index, width);
    offsetRef.current = targetOffset;
    gsap.killTweensOf(el);
    gsap.set(el, { x: targetOffset, force3D: true });
  }, [enabled, isTrackLayout, surfaceWidth]);

  useLayoutEffect(() => {
    if (!enabled || !isTrackLayout) return;
    const el = pageRef.current;
    const viewport = el?.parentElement;
    if (!el || !viewport) return;

    const applyWidth = () => {
      const width = viewport.clientWidth;
      if (width <= 0 || swipeRef.current?.horizontal) return;
      surfaceWidthRef.current = width;
      const index = itemsRef.current.findIndex((item) =>
        isEqualRef.current(item, valueRef.current),
      );
      if (index < 0) return;
      const targetOffset = horizontalSwipeTrackOffset(index, width);
      offsetRef.current = targetOffset;
      gsap.set(el, { x: targetOffset, force3D: true });
    };

    applyWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(applyWidth);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [enabled, isTrackLayout]);

  useLayoutEffect(() => {
    if (enabled) return;
    swipeRef.current = null;
    pendingDirectionRef.current = null;
    const el = pageRef.current;
    if (!el) return;
    cancelPendingOffset();
    gsap.killTweensOf(el);
    clearOffset();
  }, [cancelPendingOffset, clearOffset, enabled]);

  // Kill anything still in flight when the surface goes away, so GSAP never
  // ticks a detached node.
  useLayoutEffect(
    () => () => {
      cancelPendingOffset();
      const el = pageRef.current;
      if (el) {
        gsap.killTweensOf(el);
        gsap.set(el, { clearProps: "transform,willChange" });
      }
    },
    [cancelPendingOffset],
  );

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
      const measuredSurfaceWidth = isTrackLayout ? surfaceWidth() : event.currentTarget.clientWidth;
      const nextSurfaceWidth =
        measuredSurfaceWidth > 0 ? measuredSurfaceWidth : event.currentTarget.clientWidth;
      const currentItems = itemsRef.current;
      swipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startOffsetX: offsetRef.current,
        surfaceWidth: nextSurfaceWidth,
        itemIndex: currentItems.findIndex((item) => isEqualRef.current(item, valueRef.current)),
        itemCount: currentItems.length,
        reducedMotion: prefersReducedMotion(),
        horizontal: false,
      };
      surfaceWidthRef.current = nextSurfaceWidth;
    },
    [enabled, isTrackLayout, surfaceWidth],
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
        const el = pageRef.current;
        if (el) {
          const currentX = Number(gsap.getProperty(el, "x")) || 0;
          gsap.killTweensOf(el);
          offsetRef.current = currentX;
          swipe.startOffsetX = currentX;
          // A vertical gesture must never promote the whole scrolling page.
          gsap.set(el, { force3D: true, willChange: "transform" });
        }
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      if (!swipe.reducedMotion) {
        const surfaceWidth = swipe.surfaceWidth;
        const dragOffset = horizontalSwipeDragOffset(
          swipe.itemIndex,
          swipe.itemCount,
          deltaX,
          surfaceWidth,
        );
        const nextOffset = swipe.startOffsetX + dragOffset;
        if (isTrackLayout) {
          // Track offsets accumulate one full width per page. Clamping the
          // absolute x to one width would freeze every transition after page 2.
          // horizontalSwipeDragOffset already bounds this gesture's delta and
          // applies resistance at the first and last page.
          setOffset(nextOffset);
        } else {
          // Bound a standalone page by the live surface width, falling back to
          // the absolute px ceiling only when the width is unknown.
          const bound = surfaceWidth > 0 ? surfaceWidth : HORIZONTAL_SWIPE_MAX_DRAG_PX;
          setOffset(Math.max(-bound, Math.min(bound, nextOffset)));
        }
      }

      // Stop children (ScrollArea, buttons) from treating this as a drag/scroll.
      event.preventDefault();
      event.stopPropagation();
    },
    [isTrackLayout, setOffset],
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
      pageRef,
      onPointerDownCapture: undefined,
      onPointerMoveCapture: undefined,
      onPointerUpCapture: undefined,
      onPointerCancelCapture: undefined,
      onClickCapture: undefined,
    };
  }

  return {
    pageRef,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onClickCapture,
  };
}
