import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { isMobileClient } from "@/shared/clientPlatform";

/**
 * Shared motion vocabulary, on GSAP.
 *
 * Two rules keep this affordable on a busy canvas-danmaku/player frame:
 *
 * 1. Only transforms and opacity are ever animated, so every sequence stays on
 *    the compositor. No width/height/color/filter tweens.
 * 2. Durations stay short. Touch clients get a faster settle so the next view is
 *    readable sooner under the thumb.
 *
 * Page transitions use short duration-based easing; pointer-driven swipes write
 * the transform directly while a finger is down and only tween on release, so a
 * gesture never allocates a tween per frame.
 */

// `useGSAP` is a plugin as far as the core is concerned; registering it here —
// the one module every animated surface imports — guarantees registration runs
// before any hook does, which is the ordering the official React skill requires.
gsap.registerPlugin(useGSAP);

// Project-wide tween defaults. Individual tweens still override where they mean
// something different, but this keeps one-off `gsap.to` calls on-brand.
gsap.defaults({ duration: 0.26, ease: "power2.out" });

/**
 * Decelerate curve for entrances — the closest built-in to the previous
 * `cubic-bezier(0.2, 0.8, 0.2, 1)` token. Built-in eases are preferred over
 * CustomEase so no extra plugin has to be registered or shipped.
 */
export const EASE_OUT = "power2.out";
/** Accelerate, for exits that should clear the screen without lingering. */
export const EASE_IN = "power2.in";
/**
 * Settle for pointer-driven motion.
 *
 * The release tween covers a full surface width when a swipe commits, so the
 * curve matters more than the total time: `power3.out` front-loads most of its
 * travel into the first few frames, which on a mobile WebView reads as a jerk
 * before the tail crawls. `power2.out` spreads the same distance more evenly,
 * and the slightly longer duration keeps enough frames in the fast part of the
 * curve for the compositor to interpolate smoothly.
 *
 * Unlike a spring this has a known end time, which the gesture layer needs so
 * it can tell when the page is back at rest.
 */
export const SWIPE_SETTLE = { duration: 0.52, ease: "power2.out" } as const;

/**
 * Extra travel applied to every full-page pan, as a share of its active axis.
 *
 * Deliberately just over 100%. The animated element is the padded content box
 * inside the scroller, so its own size can be smaller than the clipped viewport
 * because of padding. Translating exactly 100% can therefore leave a thin band
 * of the outgoing page visible along the edge until it unmounts. The extra 10%
 * clears that gutter on any realistic viewport.
 */
export const PAGE_PAN_PERCENT = 110;

export type MotionProfile = {
  /** Page-pan travel as a percentage of the page's size on the active axis. */
  tabTravel: number;
  enter: { duration: number; ease: string };
  exit: { duration: number; ease: string };
};

const DESKTOP_PROFILE: MotionProfile = {
  // Full-surface pan: both pages move together as one continuous viewport.
  tabTravel: PAGE_PAN_PERCENT,
  enter: { duration: 0.28, ease: EASE_OUT },
  exit: { duration: 0.28, ease: EASE_OUT },
};

const TOUCH_PROFILE: MotionProfile = {
  // Touch navigation reads as an extension of the finger: the whole page tracks
  // across the viewport, settling a touch faster than desktop.
  tabTravel: PAGE_PAN_PERCENT,
  enter: { duration: 0.24, ease: EASE_OUT },
  exit: { duration: 0.24, ease: EASE_OUT },
};

export function motionProfile(mobile: boolean = isMobileClient()): MotionProfile {
  return mobile ? TOUCH_PROFILE : DESKTOP_PROFILE;
}

/**
 * Live `prefers-reduced-motion` read.
 *
 * GSAP's `matchMedia` reverts animations created under a query when it stops
 * matching, which suits declarative setup blocks. The gesture layer instead
 * needs a plain boolean at the moment a pointer is released, so it reads the
 * query directly rather than restructuring around a media context.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
