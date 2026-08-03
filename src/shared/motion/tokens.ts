import type { Transition, Variants } from "motion/react";
import { isMobileClient } from "@/shared/clientPlatform";

/**
 * Shared motion vocabulary.
 *
 * Two rules keep this affordable on a busy canvas-danmaku/player frame, and
 * both are inherited from the CSS keyframes this replaces:
 *
 * 1. Only `opacity` and `transform` are ever animated, so every sequence stays
 *    on the compositor. No width/height/color/filter tweens.
 * 2. Durations stay short. Touch clients get tighter travel and a faster
 *    settle so a list is readable sooner under the thumb.
 *
 * Desktop leans on spring physics (interruptible, and it survives a swipe or
 * route change landing mid-flight). Touch keeps duration-based easing where a
 * predictable, quick settle matters more than overshoot.
 */

/** Material's decelerate curve — the one the previous CSS keyframes used. */
export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;
/** Accelerate, for exits that should clear the screen without lingering. */
export const EASE_IN = [0.4, 0, 1, 1] as const;
/** iOS sheet curve, retained for drawer travel. */
export const EASE_SHEET = [0.32, 0.72, 0, 1] as const;

/** Interruptible spring for pointer-driven and hover motion. */
export const SPRING_SNAPPY: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 34,
  mass: 0.7,
};

/** Softer spring for surfaces that travel a longer distance (sheets, pages). */
export const SPRING_SOFT: Transition = {
  type: "spring",
  stiffness: 320,
  damping: 30,
  mass: 0.9,
};

export type MotionProfile = {
  /** Vertical travel for an entering page or list item, in px. */
  pageTravel: number;
  /** Horizontal travel for a directional tab transition, in px. */
  tabTravel: number;
  /** Per-item stagger for list entrances, in seconds. */
  stagger: number;
  /** Cap on staggered children so a long list cannot animate hundreds of nodes. */
  maxStaggerItems: number;
  enter: Transition;
  exit: Transition;
};

const DESKTOP_PROFILE: MotionProfile = {
  pageTravel: 8,
  tabTravel: 24,
  stagger: 0.035,
  maxStaggerItems: 12,
  enter: { duration: 0.26, ease: EASE_OUT },
  exit: { duration: 0.16, ease: EASE_IN },
};

const TOUCH_PROFILE: MotionProfile = {
  // Touch navigation reads as an extension of the finger: further travel on the
  // horizontal axis (matching the old 44px --tab-enter-x) but a shorter settle.
  pageTravel: 6,
  tabTravel: 44,
  stagger: 0.024,
  maxStaggerItems: 8,
  enter: { duration: 0.22, ease: EASE_OUT },
  exit: { duration: 0.14, ease: EASE_IN },
};

export function motionProfile(mobile: boolean = isMobileClient()): MotionProfile {
  return mobile ? TOUCH_PROFILE : DESKTOP_PROFILE;
}

/**
 * Orchestration-only container: it animates nothing itself and exists purely to
 * drive `staggerChildren`. The page wrapper in Shell already owns the route
 * transform, so adding a second fade here would double up on the same pixels.
 */
export function staggerContainerVariants(profile: MotionProfile): Variants {
  return {
    hidden: {},
    visible: {
      // No `delayChildren`: the container mounts only once its data is in hand,
      // so any lead-in here is dead time the user reads as lag rather than as
      // sequencing. The per-item stagger alone carries the sense of order.
      transition: { staggerChildren: profile.stagger },
    },
  };
}

/** Heading and control rows lead the sequence with a shorter travel. */
export function headingVariants(profile: MotionProfile): Variants {
  return {
    hidden: { opacity: 0, y: profile.pageTravel },
    visible: { opacity: 1, y: 0, transition: profile.enter },
  };
}

/**
 * Page-level container. `staggerChildren` drives item entrances from the
 * parent, so a page does not need to hand every child an index-based delay.
 */
export function pageVariants(profile: MotionProfile): Variants {
  return {
    hidden: { opacity: 0, y: profile.pageTravel },
    visible: {
      opacity: 1,
      y: 0,
      transition: { ...profile.enter, staggerChildren: profile.stagger },
    },
    exit: { opacity: 0, transition: profile.exit },
  };
}

/** Directional variants for history-driven tab navigation. */
export function tabVariants(profile: MotionProfile, direction: 1 | -1): Variants {
  return {
    hidden: { opacity: 0, x: direction * profile.tabTravel },
    visible: {
      opacity: 1,
      x: 0,
      transition: { ...profile.enter, staggerChildren: profile.stagger },
    },
    exit: { opacity: 0, transition: profile.exit },
  };
}

/** Child of a `pageVariants`/`tabVariants` container. */
export function itemVariants(profile: MotionProfile): Variants {
  return {
    hidden: { opacity: 0, y: profile.pageTravel + 4 },
    visible: { opacity: 1, y: 0, transition: profile.enter },
  };
}
