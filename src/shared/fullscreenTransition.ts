/**
 * Pins the app shell's safe-area padding across an entering fullscreen transition.
 *
 * Entering fullscreen on Android hides the system bars immersively, and a
 * landscape orientation lock can change the status-bar inset too. Chromium
 * reports each intermediate value through `env(safe-area-inset-top)`, which
 * `.app-shell` consumes as `padding-top`.
 *
 * Both fullscreen implementations need the hold, for the same reason from two
 * directions:
 *
 * - The in-page layer (Android Tauri, see `androidImmersive`) lifts the stage
 *   out of flow in the same frame the mode changes, so the picture cannot move —
 *   but the room chrome still behind it keeps reflowing for every intermediate
 *   inset, which shows around the layer's edges until it settles.
 * - The browser Fullscreen API (mobile web) applies `:fullscreen` only after the
 *   request resolves, so until then the room is laid out normally and every
 *   intermediate inset relaid it out: the top bar and the fixed-ratio video slid
 *   up and the `flex-1` danmaku panel absorbed the freed height. That is the
 *   originally reported bug — the chat growing taller for a few frames before
 *   the picture finally fills the screen.
 *
 * Freezing the padding at the value it had when the gesture started keeps the
 * page behind the stage stationary, so the inset animation no longer reflows it.
 */
export const FULLSCREEN_TRANSITION_ATTRIBUTE = "data-fullscreen-transition";

/** Custom property the CSS rule pins `.app-shell`'s `padding-top` to. */
export const FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY = "--fullscreen-transition-safe-area-top";

/**
 * Upper bound for the freeze, in case no `fullscreenchange` ever arrives.
 *
 * A refused request already releases synchronously; this only covers a WebView
 * that resolves `requestFullscreen()` without ever firing the event. Long enough
 * to outlast the system-bar animation, short enough that a stuck freeze cannot
 * outlive the interaction that set it.
 */
export const FULLSCREEN_TRANSITION_TIMEOUT_MS = 1_200;

/** The subset of `HTMLElement` this module touches, so it stays testable. */
export type FullscreenTransitionRoot = {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

/**
 * Only the inset-driven mobile shell reflows mid-transition.
 *
 * Desktop Tauri swaps to a native window fullscreen and carries no safe-area
 * padding, so freezing there would pin nothing while needlessly ignoring an
 * unrelated inset change.
 */
export function shouldFreezeFullscreenInsets(platform: string): boolean {
  return platform !== "desktop";
}

/**
 * Normalises a computed `padding-top` into a value worth pinning.
 *
 * A zero or unreadable inset has nothing to hold still, and reporting that as
 * `null` lets the caller skip the freeze entirely rather than install an
 * override that changes no layout.
 */
export function frozenSafeAreaTopValue(paddingTop: string | null | undefined): string | null {
  if (!paddingTop) return null;
  const value = paddingTop.trim();
  if (!value) return null;
  const pixels = Number.parseFloat(value);
  if (!Number.isFinite(pixels) || pixels <= 0) return null;
  return value;
}

/**
 * Freezes the shell padding and returns the matching release.
 *
 * The release is idempotent, so whichever of `fullscreenchange`, a refused
 * request or the timeout arrives first ends the freeze and the rest are no-ops.
 * Callers keep a single release and invoke it before starting another
 * transition, so a stale one can never clear a newer freeze.
 */
export function beginFullscreenTransition(
  root: FullscreenTransitionRoot | null | undefined,
  frozenPaddingTop: string | null,
): () => void {
  if (!root || !frozenPaddingTop) return () => {};
  root.style.setProperty(FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY, frozenPaddingTop);
  root.setAttribute(FULLSCREEN_TRANSITION_ATTRIBUTE, "true");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    root.removeAttribute(FULLSCREEN_TRANSITION_ATTRIBUTE);
    root.style.removeProperty(FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY);
  };
}
