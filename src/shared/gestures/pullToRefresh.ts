/** Pull-to-refresh thresholds tuned for phone touch targets. */
export const PULL_TO_REFRESH_THRESHOLD_PX = 64;
export const PULL_TO_REFRESH_MAX_PX = 96;
export const PULL_TO_REFRESH_DIRECTION_RATIO = 1.2;
export const PULL_TO_REFRESH_LOCK_DISTANCE_PX = 8;

export type PullToRefreshProgress = {
  distance: number;
  armed: boolean;
};

/** Only start a pull when the scroll container is already at the top. */
export function canStartPullToRefresh(scrollTop: number): boolean {
  return scrollTop <= 0;
}

export function isPullToRefreshGesture(deltaX: number, deltaY: number): boolean {
  // Finger moves down → positive deltaY in screen coords when using clientY
  // start-to-current subtraction inverted: we pass (currentY - startY).
  return (
    deltaY >= PULL_TO_REFRESH_LOCK_DISTANCE_PX &&
    deltaY > Math.abs(deltaX) * PULL_TO_REFRESH_DIRECTION_RATIO
  );
}

export function pullToRefreshDistance(deltaY: number): number {
  if (deltaY <= 0) return 0;
  // Rubber-band: full tracking for the first half of the threshold, then ease.
  const damped =
    deltaY < PULL_TO_REFRESH_THRESHOLD_PX
      ? deltaY
      : PULL_TO_REFRESH_THRESHOLD_PX + (deltaY - PULL_TO_REFRESH_THRESHOLD_PX) * 0.35;
  return Math.min(PULL_TO_REFRESH_MAX_PX, damped);
}

export function isPullToRefreshArmed(distance: number): boolean {
  return distance >= PULL_TO_REFRESH_THRESHOLD_PX;
}

/** Resolve the nearest vertically scrollable ancestor, including the element itself. */
export function findVerticalScrollParent(start: Element | null): HTMLElement | null {
  let node: Element | null = start;
  while (node) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      const canScroll =
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        node.scrollHeight > node.clientHeight + 1;
      if (canScroll) return node;
      // The app shell main pane is the primary page scroller even when content
      // is shorter than one viewport (scrollTop stays 0, still the right root).
      // ScrollArea viewports need the same treatment for empty/error states;
      // otherwise a follow panel with no rows would have no pull target.
      if (node.dataset.slot === "app-content" || node.dataset.slot === "scroll-area-viewport") {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}
