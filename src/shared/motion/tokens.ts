import type { Transition, Variants } from "motion/react";
import { isMobileClient } from "@/shared/clientPlatform";

/**
 * Shared motion vocabulary.
 *
 * Two rules keep this affordable on a busy canvas-danmaku/player frame:
 *
 * 1. Only `opacity` and `transform` are ever animated, so every sequence stays
 *    on the compositor. No width/height/color/filter tweens.
 * 2. Durations stay short. Touch clients get a slightly wider travel and a
 *    faster settle so the next view is readable sooner under the thumb.
 *
 * Page transitions use short duration-based easing; pointer-driven swipes use
 * the interruptible spring below so a gesture can settle without overshoot.
 */

/** Material's decelerate curve — the one the previous CSS keyframes used. */
export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;
/** Accelerate, for exits that should clear the screen without lingering. */
export const EASE_IN = [0.4, 0, 1, 1] as const;
/** Interruptible spring for pointer-driven and hover motion. */
export const SPRING_SNAPPY: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 34,
  mass: 0.7,
};

export type MotionProfile = {
  /** Horizontal travel for a directional tab transition, in px. */
  tabTravel: number;
  enter: Transition;
  exit: Transition;
};

const DESKTOP_PROFILE: MotionProfile = {
  tabTravel: 24,
  enter: { duration: 0.26, ease: EASE_OUT },
  exit: { duration: 0.16, ease: EASE_IN },
};

const TOUCH_PROFILE: MotionProfile = {
  // Touch navigation reads as an extension of the finger: further travel on the
  // horizontal axis (matching the old 44px --tab-enter-x) but a shorter settle.
  tabTravel: 44,
  enter: { duration: 0.22, ease: EASE_OUT },
  exit: { duration: 0.14, ease: EASE_IN },
};

export function motionProfile(mobile: boolean = isMobileClient()): MotionProfile {
  return mobile ? TOUCH_PROFILE : DESKTOP_PROFILE;
}

/** Directional variants for cached page navigation. */
export function tabVariants(profile: MotionProfile, direction: 1 | -1): Variants {
  return {
    hidden: { opacity: 0, x: direction * profile.tabTravel },
    visible: {
      opacity: 1,
      x: 0,
      transition: profile.enter,
    },
    exit: {
      opacity: 0,
      x: -direction * profile.tabTravel,
      transition: profile.exit,
    },
  };
}
