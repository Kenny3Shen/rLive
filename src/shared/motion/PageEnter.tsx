import { createContext, type ReactNode, useContext, useMemo } from "react";
import { m } from "motion/react";
import { headingVariants, itemVariants, motionProfile, staggerContainerVariants } from "./tokens";

/**
 * Declarative replacement for the imperative `usePageEntrance` hook.
 *
 * Two behaviours are carried over deliberately from the Web Animations version:
 *
 * 1. **A capped number of animated nodes.** A discovery grid can hold hundreds
 *    of rooms after infinite scroll. Items past `maxStaggerItems` render as
 *    plain elements, so they cost nothing — no motion component, no tween.
 * 2. **Headings lead, items follow.** The container only orchestrates; it never
 *    animates its own pixels, because Shell's route wrapper already owns the
 *    page-level transform and a second fade would double up on it.
 *
 * Reduced motion is handled globally by `MotionConfig reducedMotion="user"`.
 */

type PageEnterProps = {
  /** Gates the sequence until the page has data worth revealing. */
  ready: boolean;
  /**
   * Cap on animated children. Items past this index render as plain elements.
   * Defaults to the profile's `maxStaggerItems`.
   */
  maxItems?: number;
  children: ReactNode;
  className?: string;
};

/**
 * Carries the container's animated-child cap down to `PageEnterItem`, so a page
 * can tighten it (categories use 8) without every item taking a prop.
 */
const MaxItemsContext = createContext<number | null>(null);

export function PageEnter({ ready, maxItems, children, className }: PageEnterProps) {
  const profile = useMemo(() => motionProfile(), []);
  const variants = useMemo(() => staggerContainerVariants(profile), [profile]);
  const cap = maxItems ?? profile.maxStaggerItems;

  return (
    <MaxItemsContext.Provider value={cap}>
      <m.div
        initial="hidden"
        animate={ready ? "visible" : "hidden"}
        variants={variants}
        className={className}
      >
        {children}
      </m.div>
    </MaxItemsContext.Provider>
  );
}

/** Heading and control rows, which lead the stagger with a shorter travel. */
export function PageEnterHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const profile = useMemo(() => motionProfile(), []);
  const variants = useMemo(() => headingVariants(profile), [profile]);

  return (
    <m.div variants={variants} className={className}>
      {children}
    </m.div>
  );
}

type PageEnterItemProps = {
  /**
   * Position in the list. Past the profile's cap this renders a plain `div`, so
   * a long grid does not pay for motion components it will never visibly use.
   */
  index: number;
  children: ReactNode;
  className?: string;
};

export function PageEnterItem({ index, children, className }: PageEnterItemProps) {
  const profile = useMemo(() => motionProfile(), []);
  const variants = useMemo(() => itemVariants(profile), [profile]);
  const cap = useContext(MaxItemsContext) ?? profile.maxStaggerItems;

  if (index >= cap) {
    return <div className={className}>{children}</div>;
  }

  return (
    <m.div variants={variants} className={className}>
      {children}
    </m.div>
  );
}
