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
  /** Recent pointer positions, used to derive the release velocity. */
  samples: HorizontalSwipeSample[];
};

type HorizontalSwipeLayout = "page" | "track";

const HORIZONTAL_SWIPE_SURFACE_SELECTOR = "[data-horizontal-swipe-surface]";
/** Enough samples to cover the velocity window at any realistic pointer rate. */
const HORIZONTAL_SWIPE_MAX_SAMPLES = 8;
/**
 * Grace period for a committed value to arrive, in ms.
 *
 * A caller may legitimately not apply the change on the next frame. React
 * Router's `BrowserRouter` wraps every location update in `startTransition`, so
 * a swipe that navigates — the platform and follow-filter strips both do, via
 * search params — commits one or more frames later, and on a heavy route the
 * concurrent render can take longer still. Only a caller that never applies the
 * value at all should see the page returned to where it started, so the window
 * is generous: an unnecessary rollback is a visible snap backwards, while
 * waiting a little too long is invisible — the page is already sitting at its
 * destination.
 */
const HORIZONTAL_SWIPE_COMMIT_GRACE_MS = 600;

function transformFor(offset: number): string {
  return `translate3d(${offset}px, 0, 0)`;
}

export type UseHorizontalSwipeOptions<T> = {
  items: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** Enables touch swipe gestures. Defaults to true. */
  enabled?: boolean;
  /** Animates value changes regardless of gesture availability. Defaults to true. */
  animate?: boolean;
  /**
   * `track` moves a layer whose pages are all laid out side by side at
   * `index * width`, so the neighbours are already painted and the gesture pans
   * between real pages. `page` moves the single rendered page and relies on the
   * value change to bring the next one in, for strips whose neighbours are not
   * mounted.
   */
  layout?: HorizontalSwipeLayout;
  isEqual?: (left: T, right: T) => boolean;
};

/**
 * Interactive paging for an ordered tab/platform strip.
 *
 * Capture-phase pointer handlers are required on Android WebView: scrollable
 * children (ScrollArea, overflow lists) otherwise claim the gesture and the
 * parent never sees pointermove. `touch-action: pan-y` on the surface keeps
 * vertical scrolling native while leaving horizontal motion to this hook.
 *
 * Attach `pageRef` to the element that should travel. Two properties make the
 * transition read as one continuous movement rather than a page switch followed
 * by an animation:
 *
 * 1. While a finger is down the transform is written straight from the
 *    pointermove handler. Coalescing those writes into a rAF callback would
 *    always paint the pointer position of the previous frame, which is exactly
 *    what "not following the finger" looks like.
 * 2. The release is a Web Animations transform, so Chromium advances it on the
 *    compositor. GSAP (and any rAF ticker) has to share the main thread with the
 *    React commit that the page change triggers — on a heavy route that commit
 *    is long enough to swallow most of the settle's frames, which is what made a
 *    committed swipe look like an instant switch followed by a slide.
 *
 * Its duration and the commit decision both come from the gesture itself: how
 * much of the surface the page travelled, and how fast the finger was moving
 * when it lifted.
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
  // Last observed surface width, so a released swipe knows how far a full-width
  // page travel actually is. Also the cap for the follow-the-finger drag.
  const surfaceWidthRef = useRef(0);
  const offsetRef = useRef(0);
  const animationRef = useRef<Animation | null>(null);
  const commitDeliveryFrameRef = useRef<number | null>(null);
  /** Set between a gesture commit and the value change it asked for. */
  const pendingCommitRef = useRef<{ value: T; direction: 1 | -1; velocity: number } | null>(null);
  const commitRollbackTimerRef = useRef<number | null>(null);
  /** Watches the track's viewport. One per attached node, replaced on rebind. */
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

      // The first rAF returns without React work, guaranteeing the compositor
      // can paint the release motion once. The value change runs in the next
      // frame; even if mounting the new platform is expensive, the already
      // running Web Animation keeps advancing instead of pausing under the
      // finger's release point.
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
    // A track is wider than the viewport it travels inside, so it measures the
    // clipping parent. A standalone page sits inside a padded scroller and is
    // therefore narrower than the surface it pans across — measure the gesture
    // surface itself, or a page would enter from its own width and leave a band
    // of the outgoing page along the edge.
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

  /** Offset actually on screen, including a settle still in flight. */
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

  /** Stop a settle where it currently is, leaving that offset as inline style. */
  const cancelSettle = useCallback(() => {
    const animation = animationRef.current;
    if (!animation) return;
    const stoppedAt = liveOffset();
    animationRef.current = null;
    animation.cancel();
    writeOffset(stoppedAt);
  }, [liveOffset, writeOffset]);

  /**
   * Hand the remaining travel to the compositor.
   *
   * `fill: both` makes the first keyframe apply as soon as the animation starts,
   * so the layer never paints an untransformed frame between the inline write and
   * the animation taking over.
   */
  const settle = useCallback(
    (target: number, duration: number) => {
      const el = pageRef.current;
      if (!el) return;
      cancelSettle();
      const from = offsetRef.current;
      // A standalone page rests at 0, which is also its natural layout position:
      // landing there drops the transform entirely rather than leaving the page
      // on a permanent compositor layer. A track's rest position is a transform.
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
          // Inline style first, then drop the effect: reversing the order lets
          // some Android compositors paint the untransformed layer for a frame.
          el.style.transform = restsUntransformed ? "" : transformFor(target);
          animation.cancel();
          el.style.willChange = "";
        })
        .catch(() => {
          // Cancellation is expected when a new gesture or value interrupts.
        });
    },
    [cancelSettle, isTrackLayout],
  );

  /** Park the layer at the offset its current value implies, without motion. */
  const restAtValue = useCallback(() => {
    cancelSettle();
    const el = pageRef.current;
    const target = restOffsetForValue(valueRef.current);
    offsetRef.current = target;
    if (!el) return;
    el.style.willChange = "";
    // A settled standalone page returns to normal painting instead of keeping a
    // permanent compositor layer; a track's rest position *is* a transform.
    if (isTrackLayout) el.style.transform = transformFor(target);
    else el.style.transform = "";
  }, [cancelSettle, isTrackLayout, restOffsetForValue]);

  /** Return whatever offset the finger left behind to the current page. */
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

    // A track's pages are laid out by absolute index, so committing a swipe does
    // not move any of them: the settle started at release is already travelling
    // to this value's rest offset and must be left alone.
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
      // Only the immediate neighbours are mounted, so a multi-step jump would
      // sweep across pages that are not there. Land on it instead.
      if (Math.abs(nextIndex - previousIndex) !== 1) {
        restAtValue();
        return;
      }
      settle(restOffsetForIndex(nextIndex), profile.enter.duration * 1000);
      return;
    }

    // `page`: the old page followed the finger out and the incoming one only
    // exists now. Place it a full surface width across the opposite edge and
    // settle it in, so the release plays as one continuous pan rather than a
    // short catch-up nudge.
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
   * Park the track at the offset its current value implies, and keep measuring
   * the viewport it travels inside.
   *
   * Positioning a track is layout rather than gesture, so this also runs on
   * clients without touch: the strip must show the selected page even when no
   * pointer will ever reach it.
   *
   * Runs on mount *and* on every rebind, because a caller may replace the track
   * while this hook stays mounted. The Shell's `PagePan` is keyed on the
   * pathname, so leaving a swipeable route and coming back rebuilds the whole
   * viewport/track/panel subtree — and assigning a ref does not re-run layout
   * effects, so parking only on mount left the fresh track untransformed while
   * `offsetRef` still held `-index * width`. Panels sit at their *absolute*
   * strip index, so for any page past the first that pushes the active panel
   * entirely off screen: nothing scrollable under the finger, and a horizontal
   * gesture whose commit only remounts pages.
   *
   * A standalone `page` needs none of this: it rests untransformed at offset 0,
   * which is where a freshly mounted node already sits.
   */
  const parkTrack = useCallback(() => {
    disconnectTrackResize();
    if (!isTrackLayout) return;
    const el = pageRef.current;
    const viewport = el?.parentElement;
    if (!el || !viewport) return;

    const applyWidth = () => {
      const width = viewport.clientWidth;
      // Mid-gesture the finger owns the offset; a resize then is a keyboard or
      // system bar appearing, and rebasing under the pointer would jump.
      if (width <= 0 || swipeRef.current?.horizontal) return;
      surfaceWidthRef.current = width;
      const index = itemsRef.current.findIndex((item) =>
        isEqualRef.current(item, valueRef.current),
      );
      if (index < 0) return;
      cancelSettle();
      writeOffset(horizontalSwipeTrackOffset(index, width));
    };

    // Observing happens even mid-gesture — `applyWidth` decides for itself
    // whether it may move the layer — so a track bound while a finger is down
    // is not left permanently unmeasured.
    applyWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(applyWidth);
    trackResizeObserverRef.current = observer;
    observer.observe(viewport);
  }, [cancelSettle, disconnectTrackResize, isTrackLayout, writeOffset]);

  /**
   * Attach the element that should travel. The only way in: this is a callback
   * ref rather than a ref object precisely so that replacing the surface cannot
   * go unnoticed.
   *
   * Its identity changes with `layout`, so React re-invokes it — and `parkTrack`
   * runs again — whenever either the node or the layout changes, and at no other
   * time. A gesture commit leaves the node alone, so the settle it started is
   * never interrupted.
   */
  const bindPage = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      pageRef.current = node;
      parkTrack();
      return () => {
        // A retained exit animation (PagePan keeps the outgoing page alive) means
        // this cleanup can run while a newer surface is already bound and
        // observed. Only the node still in charge may tear anything down.
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

  // Drop anything still in flight when the surface goes away, so no animation
  // ticks against a detached node and no timer fires into an unmounted hook.
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
      const measured = surfaceWidth();
      const nextSurfaceWidth = measured > 0 ? measured : event.currentTarget.clientWidth;
      const currentItems = itemsRef.current;
      swipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        // Provisional: a settle may still be running, and the offset it has
        // reached is only read once the gesture locks horizontal.
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
          // Take over from a settle at the exact pixel it reached, so grabbing a
          // page mid-transition continues from there instead of snapping.
          cancelSettle();
          swipe.startOffset = offsetRef.current;
          // Only promote the layer once the gesture is known to be horizontal; a
          // vertical scroll must never promote the whole scrolling page.
          el.style.willChange = "transform";
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        // Restart sampling from the lock point: the pre-lock samples describe a
        // gesture that had not yet been recognised as paging.
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
          // Track offsets accumulate one full width per page. Clamping the
          // absolute offset to one width would freeze every page past the
          // second. `horizontalSwipeDragOffset` already bounds this gesture's
          // own delta and damps it at the first and last page.
          writeOffset(nextOffset);
        } else {
          const bound = width > 0 ? width : HORIZONTAL_SWIPE_MAX_DRAG_PX;
          writeOffset(Math.max(-bound, Math.min(bound, nextOffset)));
        }
      }

      // Stop children (ScrollArea, buttons) from treating this as a drag/scroll.
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

      // Start the settle before telling React, and in that order. A track's
      // pages are positioned by absolute index, so the commit moves nothing the
      // animation cares about — while waiting for the value change first would
      // put the whole React commit between the finger lifting and the first
      // animated frame.
      if (isTrackLayout) {
        const target = restOffsetForIndex(nextIndex);
        settle(target, horizontalSwipeSettleDuration(target - offsetRef.current, velocity));
      }
      deliverCommittedChange(next);

      // Last resort for a caller that rejects the change outright, so the page
      // is not left parked between two pages. Deliberately a timer rather than
      // the next frame: a value delivered through a transition legitimately
      // takes several frames, and rolling back before it lands would undo the
      // settle that is already running.
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
