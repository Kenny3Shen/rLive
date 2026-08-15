/**
 * Shared horizontal tab / platform swipe helpers.
 *
 * Simple Live uses TabBarView for site and room panels. rLive keeps the same
 * left/right navigation contract on touch clients without requiring a full
 * page-view carousel.
 */

export const HORIZONTAL_SWIPE_DIRECTION_RATIO = 1.25;
export const HORIZONTAL_SWIPE_LOCK_DISTANCE_PX = 10;
export const HORIZONTAL_SWIPE_CLICK_SUPPRESSION_MS = 420;
/**
 * Hard ceiling for the follow-the-finger drag, in px. Sits above any realistic
 * viewport width so the phone-style pan is bounded by the surface width (below),
 * not by a fixed nudge — the page can track the finger all the way across.
 */
export const HORIZONTAL_SWIPE_MAX_DRAG_PX = 4096;
/**
 * Share of the surface the committed page starts from before settling in. `1`
 * means the incoming page begins a full width off-screen, so the release plays
 * as one continuous edge-to-edge pan rather than a short catch-up nudge.
 */
export const HORIZONTAL_SWIPE_PAGE_ENTRY_RATIO = 1;
const HORIZONTAL_SWIPE_MAX_DRAG_SURFACE_RATIO = 1;
const HORIZONTAL_SWIPE_EDGE_RESISTANCE = 0.18;

/**
 * Share of the surface a slow drag must cover before the release changes page.
 *
 * This is the interactive half of the paging contract: what decides the commit
 * is how far the page actually travelled, not how many pixels the finger moved.
 * A quarter of the surface: the neighbouring page is painted and tracking the
 * finger by then, so a drag carried that far already reads as committed. Near
 * the midpoint it did not — a deliberate third-of-a-screen drag sprang back.
 */
export const HORIZONTAL_SWIPE_COMMIT_PROGRESS = 0.1;
/**
 * Release speed, in px/ms, above which a flick pages regardless of progress.
 *
 * ~0.32 px/ms is a brisk but unremarkable flick (roughly 320 px/s). Below it the
 * gesture is treated as a positional drag and judged by progress alone.
 */
export const HORIZONTAL_SWIPE_FLING_VELOCITY_PX_PER_MS = 0.32;
/** Bounds for the release settle, in ms. */
export const HORIZONTAL_SWIPE_SETTLE_MIN_MS = 170;
export const HORIZONTAL_SWIPE_SETTLE_MAX_MS = 400;
/**
 * Speed window, px/ms, the settle duration is derived within.
 *
 * The settle continues motion the finger started, so its duration comes from
 * the distance still to cover divided by the release speed. Clamping that speed
 * keeps a near-stationary release from producing a multi-second crawl and a
 * violent flick from snapping in a single frame.
 */
export const HORIZONTAL_SWIPE_SETTLE_MIN_SPEED = 0.7;
export const HORIZONTAL_SWIPE_SETTLE_MAX_SPEED = 3;
/**
 * Sampling window for release velocity, in ms.
 *
 * Pointer samples arrive one per compositor frame, so a single pair of events is
 * noisy. Smoothing over roughly two frames keeps a steady drag from reading as a
 * flick while still reacting within the same gesture.
 */
export const HORIZONTAL_SWIPE_VELOCITY_WINDOW_MS = 32;

export type HorizontalSwipeSample = {
  /** Pointer position along the gesture axis, in px. */
  x: number;
  /** `performance.now()` at the time of the sample. */
  time: number;
};

/**
 * Release speed along the gesture axis, in px/ms, from a tail of samples.
 *
 * Pointer moves arrive roughly one per compositor frame, so differentiating the
 * last two events alone is noisy enough to read a steady drag as a flick.
 * Averaging over the samples inside `windowMs` smooths that out, and because the
 * window is measured back from the newest sample, a finger that paused before
 * lifting reports ~0 instead of inheriting the speed it had before the pause.
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
 * Signed share of a surface the live drag currently covers.
 *
 * This is the value a paging transition interpolates against: at ±1 the
 * neighbouring page has fully replaced the current one.
 */
export function horizontalSwipeProgress(dragOffset: number, surfaceWidth: number): number {
  if (!(surfaceWidth > 0)) return 0;
  return Math.max(-1, Math.min(1, dragOffset / surfaceWidth));
}

/**
 * Whether releasing here should land on the neighbour the drag was heading for.
 *
 * The drag's own sign picks the candidate page; this only decides commit versus
 * return, the way a phone pager does:
 *
 * - a flick that agrees with the drag commits at any distance, so a quick flick
 *   pages without having to cross the screen;
 * - a flick back toward the start cancels at any distance, so a drag pulled back
 *   past the midpoint does not page against the user's last intent;
 * - otherwise the decision is positional — how much of the surface the page
 *   actually travelled.
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

/**
 * Index the strip lands on when the pointer is released, or null to stay put.
 * A negative offset (finger moved left) advances; positive goes back.
 */
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
 * How long the release should take to cover the remaining distance, in ms.
 *
 * A settle continues the gesture rather than playing a canned transition, so its
 * duration follows from the distance left and the speed the finger let go at.
 * The speed is clamped so a near-stationary release does not crawl and a hard
 * flick does not snap within a single frame; the result is clamped again so the
 * total time stays inside the range that reads as one continuous movement.
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
 * Horizontal offset used while a page follows the pointer.
 *
 * A valid direction follows the finger up to a full surface width, so the page
 * can pan edge to edge like phone navigation. At the first/last page the same
 * movement is heavily damped, making the boundary visible without suggesting
 * that the strip wraps around.
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

/** Position a full-width paging track at the requested item. */
export function horizontalSwipeTrackOffset(index: number, surfaceWidth: number): number {
  const normalizedIndex = Math.max(0, index);
  const width = Math.max(0, surfaceWidth);
  return normalizedIndex === 0 || width === 0 ? 0 : -normalizedIndex * width;
}

/**
 * Rebase a committed drag around the newly selected page without changing the
 * pixels currently under the finger. The new page becomes the track origin,
 * so one page width is added in the navigation direction before settling to 0.
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
 * Continuous horizontal gestures (sliders, text fields) and explicit drag
 * handles own the pointer.
 * Ordinary buttons and list rows stay swipeable; a recognised swipe suppresses
 * the synthetic click that Android WebView may still emit.
 */
export function isHorizontalSwipeIgnoredTarget(target: EventTarget | null): boolean {
  if (!target || typeof Element === "undefined" || typeof Node === "undefined") return false;
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return Boolean(
    element?.closest(
      'input, textarea, select, [contenteditable="true"], [role="slider"], [role="combobox"], [data-dnd-handle], [data-slot="slider"], [data-slot^="slider-"], [data-slot="scroll-area-scrollbar"], [data-slot="scroll-area-thumb"]',
    ),
  );
}
