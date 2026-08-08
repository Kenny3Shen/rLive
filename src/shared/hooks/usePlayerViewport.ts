import { useEffect, useState } from "react";
import { isMobileClient } from "@/shared/clientPlatform";

export const COMPACT_LANDSCAPE_PLAYER_QUERY =
  "(orientation: landscape) and (max-height: 540px) and (pointer: coarse)";
export const COMPACT_PLAYER_QUERY = `(max-width: 767px), ${COMPACT_LANDSCAPE_PLAYER_QUERY}`;
export const PORTRAIT_ORIENTATION_QUERY = "(orientation: portrait)";

function matches(query: string): boolean {
  return typeof window !== "undefined" && window.matchMedia(query).matches;
}

function isLandscapeViewport(): boolean {
  if (typeof window === "undefined") return false;

  const orientationType = window.screen.orientation?.type;
  if (orientationType) return orientationType.startsWith("landscape");

  const orientationAngle = window.screen.orientation?.angle;
  if (orientationAngle === 90 || orientationAngle === 270) return true;
  if (orientationAngle === 0 || orientationAngle === 180) return false;

  const legacyOrientation = (window as Window & { orientation?: number }).orientation;
  if (legacyOrientation === 90 || legacyOrientation === -90 || legacyOrientation === 270) {
    return true;
  }
  if (legacyOrientation === 0 || legacyOrientation === 180) return false;

  const viewport = window.visualViewport;
  return (viewport?.width ?? window.innerWidth) > (viewport?.height ?? window.innerHeight);
}

/**
 * A mobile WebView can report its pre-layout media-query state during the first
 * render. Seed the player with a mobile-safe answer until the real media query
 * listener gets its first settled update.
 */
export function playerViewportFallbackMatches(
  query: string,
  mobileClient: boolean,
  landscape: boolean,
): boolean {
  if (!mobileClient) return false;
  if (query === COMPACT_PLAYER_QUERY) return true;
  if (query === COMPACT_LANDSCAPE_PLAYER_QUERY) return landscape;
  if (query === PORTRAIT_ORIENTATION_QUERY) return !landscape;
  return false;
}

function initialMatches(query: string): boolean {
  if (matches(query)) return true;
  return playerViewportFallbackMatches(query, isMobileClient(), isLandscapeViewport());
}

/**
 * Resolves a player layout query and keeps it correct across the cold start.
 *
 * A WebView evaluates `matchMedia` against the viewport it has at the time of
 * the call, and on the first launch that viewport is not settled yet: the
 * initial `useState` read and the mount-time re-read can both return the
 * pre-layout answer, and the browser does not necessarily emit a `change` event
 * for that initial correction. A player bar that resolved `compact` as `false`
 * would then keep desktop density — extra buttons plus the inline composer in
 * the centre slot — until some unrelated resize finally fired.
 *
 * So the mount effect re-reads on the next frame as well, and viewport events
 * are treated as a re-read trigger alongside the `change` listener. Every read
 * funnels through one setter, and React drops same-value updates, so the extra
 * checks cost nothing once the value is stable.
 */
function usePlayerMediaQuery(query: string): boolean {
  const [matched, setMatched] = useState(() => initialMatches(query));

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const update = () =>
      setMatched(
        mediaQuery.matches ||
          playerViewportFallbackMatches(query, isMobileClient(), isLandscapeViewport()),
      );
    // Keep the mobile-safe answer even if this WebView never emits the initial
    // media-query correction. A later orientation/resize event recomputes the
    // fallback, so rotating the device still switches the layout correctly.
    update();
    const updateFromEvent = () => update();

    // Cross two layout/paint passes. Android can settle edge-to-edge insets and
    // orientation after the first frame, without emitting a media-query change.
    let secondFrame: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(update);
    });

    mediaQuery.addEventListener("change", updateFromEvent);
    window.addEventListener("resize", updateFromEvent);
    window.addEventListener("orientationchange", updateFromEvent);
    window.visualViewport?.addEventListener("resize", updateFromEvent);
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      mediaQuery.removeEventListener("change", updateFromEvent);
      window.removeEventListener("resize", updateFromEvent);
      window.removeEventListener("orientationchange", updateFromEvent);
      window.visualViewport?.removeEventListener("resize", updateFromEvent);
    };
  }, [query]);

  return matched;
}

/** Use the same control density on portrait phones and short touch landscapes. */
export function useCompactPlayerViewport(): boolean {
  return usePlayerMediaQuery(COMPACT_PLAYER_QUERY);
}

export function useCompactLandscapePlayerViewport(): boolean {
  return usePlayerMediaQuery(COMPACT_LANDSCAPE_PLAYER_QUERY);
}

/** Portrait orientation, resolved through the shared query path so the first
 * paint and later change events agree instead of ad-hoc matchMedia per caller. */
export function usePortraitOrientation(): boolean {
  return usePlayerMediaQuery(PORTRAIT_ORIENTATION_QUERY);
}
