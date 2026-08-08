import { useEffect, useState } from "react";

export const COMPACT_LANDSCAPE_PLAYER_QUERY =
  "(orientation: landscape) and (max-height: 540px) and (pointer: coarse)";
export const COMPACT_PLAYER_QUERY = `(max-width: 767px), ${COMPACT_LANDSCAPE_PLAYER_QUERY}`;

function matches(query: string): boolean {
  return typeof window !== "undefined" && window.matchMedia(query).matches;
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
  const [matched, setMatched] = useState(() => matches(query));

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const update = () => setMatched(mediaQuery.matches);
    update();

    // Second read after the first layout/paint pass, for the cold start where
    // the synchronous reads above still saw the pre-layout viewport.
    const frame = window.requestAnimationFrame(update);

    mediaQuery.addEventListener("change", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.cancelAnimationFrame(frame);
      mediaQuery.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
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

export const PORTRAIT_ORIENTATION_QUERY = "(orientation: portrait)";

/** Portrait orientation, resolved through the shared query path so the first
 * paint and later change events agree instead of ad-hoc matchMedia per caller. */
export function usePortraitOrientation(): boolean {
  return usePlayerMediaQuery(PORTRAIT_ORIENTATION_QUERY);
}
