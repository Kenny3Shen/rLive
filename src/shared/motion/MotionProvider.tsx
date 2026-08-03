import { LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { EASE_OUT } from "./tokens";

/**
 * Loads motion's DOM feature bundle on demand.
 *
 * The repo deliberately keeps animation code off the path to first room-grid
 * paint (the reason the former GSAP timeline was replaced by native Web
 * Animations). A dynamic import preserves that: only motion's core is in the
 * initial chunk, and the feature bundle (see domAnimationFeatures.ts, split
 * into its own chunk) arrives in parallel with the first data fetch. Until it
 * resolves, `m` elements render as plain DOM at their `initial` style, so
 * nothing flashes unstyled.
 *
 * `domAnimation` intentionally excludes `drag` and layout projection. Gesture
 * surfaces therefore keep their existing pointer logic (which handles real
 * Android WebView capture quirks) and drive MotionValues instead of using
 * motion's own drag, so `domMax` is never needed.
 */
const loadDomAnimation = () => import("./domAnimationFeatures").then((mod) => mod.default);

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    // `strict` makes any `motion.*` import throw, which is what keeps the
    // tree-shaken `m` path from silently regressing back to the full bundle.
    <LazyMotion features={loadDomAnimation} strict>
      {/* `reducedMotion: "user"` makes every transform/opacity tween respect
          prefers-reduced-motion at the source, replacing the per-call
          matchMedia checks the CSS/WAAPI code needed. */}
      <MotionConfig reducedMotion="user" transition={{ duration: 0.26, ease: EASE_OUT }}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
