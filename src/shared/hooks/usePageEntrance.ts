import { useLayoutEffect, useRef, type RefObject } from "react";
import { gsap } from "gsap";

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
 * not create a matching number of animations.
 */
export function usePageEntrance(
  rootRef: RefObject<HTMLElement | null>,
  { entryKey, ready, itemSelector = DEFAULT_ITEM_SELECTOR, maxItems = 12 }: PageEntranceOptions,
) {
  const animatedKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !ready || animatedKeyRef.current === entryKey) return;

    const headingTargets = Array.from(
      root.querySelectorAll<HTMLElement>("[data-page-enter-heading], [data-page-enter-controls]"),
    );
    const itemTargets = Array.from(root.querySelectorAll<HTMLElement>(itemSelector)).slice(
      0,
      maxItems,
    );
    const targets = [...headingTargets, ...itemTargets];

    if (targets.length === 0) return;
    animatedKeyRef.current = entryKey;

    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.set(targets, { willChange: "transform, opacity" });

      const sequence = gsap.timeline({ defaults: { ease: "power2.out" } });
      if (headingTargets.length > 0) {
        sequence.from(headingTargets, {
          autoAlpha: 0,
          duration: 0.22,
          y: 8,
          stagger: 0.035,
        });
      }
      if (itemTargets.length > 0) {
        sequence.from(
          itemTargets,
          {
            autoAlpha: 0,
            duration: 0.3,
            y: 12,
            stagger: 0.035,
          },
          headingTargets.length > 0 ? "-=0.1" : 0,
        );
      }
      sequence.set(targets, {
        clearProps: "willChange,transform,opacity,visibility",
      });
    });

    return () => media.revert();
  }, [entryKey, itemSelector, maxItems, ready, rootRef]);
}
