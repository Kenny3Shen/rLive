/**
 * Shared horizontal tab / platform swipe helpers.
 *
 * Simple Live uses TabBarView for site and room panels. rLive keeps the same
 * left/right navigation contract on touch clients without requiring a full
 * page-view carousel.
 */

export const HORIZONTAL_SWIPE_MIN_DISTANCE_PX = 48;
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

/** A deliberate horizontal drag wins over a diagonal or vertical gesture. */
export function isHorizontalSwipe(deltaX: number, deltaY: number): boolean {
  const horizontalDistance = Math.abs(deltaX);
  return (
    horizontalDistance >= HORIZONTAL_SWIPE_MIN_DISTANCE_PX &&
    horizontalDistance > Math.abs(deltaY) * HORIZONTAL_SWIPE_DIRECTION_RATIO
  );
}

/**
 * Returns the adjacent item index for a left/right swipe, or null when the
 * gesture is too short/vertical or already at either end of the strip.
 * Left swipe advances; right swipe goes back.
 */
export function nextIndexForHorizontalSwipe(
  currentIndex: number,
  length: number,
  deltaX: number,
  deltaY: number,
): number | null {
  if (length <= 1 || currentIndex < 0 || currentIndex >= length) return null;
  if (!isHorizontalSwipe(deltaX, deltaY)) return null;
  const direction = deltaX < 0 ? 1 : -1;
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= length) return null;
  return nextIndex;
}

export function nextItemForHorizontalSwipe<T>(
  items: readonly T[],
  current: T,
  deltaX: number,
  deltaY: number,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T | null {
  const currentIndex = items.findIndex((item) => isEqual(item, current));
  const nextIndex = nextIndexForHorizontalSwipe(currentIndex, items.length, deltaX, deltaY);
  return nextIndex === null ? null : (items[nextIndex] ?? null);
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
