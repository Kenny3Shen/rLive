import { useLayoutEffect, useRef, type RefObject } from "react";
import { isMobileClient } from "@/shared/clientPlatform";

type PageEntranceOptions = {
  entryKey: string;
  ready: boolean;
  itemSelector?: string;
  maxItems?: number;
};

const DEFAULT_ITEM_SELECTOR = "[data-page-enter-item]";

/**
 * Plays one small, compositor-only entrance sequence for a page identity.
 * It intentionally limits list targets so a large room or follow list does
 * not create a matching number of animations. Touch clients get a tighter
 * stagger and shorter travel so the list settles sooner under the thumb.
 */
export function usePageEntrance(
  rootRef: RefObject<HTMLElement | null>,
  { entryKey, ready, itemSelector = DEFAULT_ITEM_SELECTOR, maxItems = 12 }: PageEntranceOptions,
) {
  const animatedKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (
      !root ||
      !ready ||
      animatedKeyRef.current === entryKey ||
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const mobile = isMobileClient();
    const itemLimit = mobile ? Math.min(maxItems, 8) : maxItems;
    const staggerMs = mobile ? 24 : 35;
    const headingDurationMs = mobile ? 200 : 220;
    const itemDurationMs = mobile ? 260 : 300;
    const headingTravel = mobile ? "translate3d(0, 6px, 0)" : "translate3d(0, 8px, 0)";
    const itemTravel = mobile ? "translate3d(0, 10px, 0)" : "translate3d(0, 12px, 0)";

    const headingTargets = Array.from(
      root.querySelectorAll<HTMLElement>("[data-page-enter-heading], [data-page-enter-controls]"),
    );
    const itemTargets = Array.from(root.querySelectorAll<HTMLElement>(itemSelector)).slice(
      0,
      itemLimit,
    );
    const targets = [...headingTargets, ...itemTargets];

    if (targets.length === 0) return;
    animatedKeyRef.current = entryKey;

    // Native Web Animations keeps this short, compositor-only sequence out of
    // the initial JavaScript bundle. The app targets Chromium WebViews, where
    // `Element.animate` is available and has the same transform/opacity path
    // as the former GSAP timeline.
    const easing = "cubic-bezier(0.25, 0.46, 0.45, 0.94)";
    const animations: Animation[] = [];

    headingTargets.forEach((target, index) => {
      animations.push(
        target.animate(
          [
            { opacity: 0, transform: headingTravel },
            { opacity: 1, transform: "translate3d(0, 0, 0)" },
          ],
          { delay: index * staggerMs, duration: headingDurationMs, easing, fill: "both" },
        ),
      );
    });

    const itemStartDelay = headingTargets.length > 0 ? 120 + (headingTargets.length - 1) * staggerMs : 0;
    itemTargets.forEach((target, index) => {
      animations.push(
        target.animate(
          [
            { opacity: 0, transform: itemTravel },
            { opacity: 1, transform: "translate3d(0, 0, 0)" },
          ],
          { delay: itemStartDelay + index * staggerMs, duration: itemDurationMs, easing, fill: "both" },
        ),
      );
    });

    // `fill: both` hides an element during its delay. Release that animated
    // transform once it reaches the normal final state so card hover styles
    // can take over again instead of being held by the finished animation.
    animations.forEach((animation) => {
      animation.addEventListener("finish", () => animation.cancel(), { once: true });
    });

    return () => {
      animations.forEach((animation) => animation.cancel());
    };
  }, [entryKey, itemSelector, maxItems, ready, rootRef]);
}
