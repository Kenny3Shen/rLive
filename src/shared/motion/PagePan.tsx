import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils";
import { motionProfile, prefersReducedMotion } from "./tokens";

// CSS equivalent of GSAP's power2.out. Web Animations can advance this
// transform on Chromium's compositor while React is busy on the main thread.
const PAGE_PAN_EASING = "cubic-bezier(0.215, 0.61, 0.355, 1)";

type PanSnapshot = {
  key: string;
  node: ReactNode;
};

/**
 * Directional page pan, replacing `AnimatePresence` + variants.
 *
 * React unmounts a subtree the moment it leaves the element tree, so an exit
 * animation needs the outgoing content kept alive past its own removal. This
 * component holds the previous child in state while it pans out, then drops
 * it — the deferred unmount that `AnimatePresence` used to provide.
 *
 * Both pages travel the same distance, in the same direction, over the same
 * duration and ease, and both stay fully opaque: the pair reads as one
 * continuous surface sliding under the thumb rather than a cross-fade.
 *
 * The outgoing page is taken out of layout flow (absolute, inset-0) for the
 * length of the transition — the equivalent of Motion's `mode="popLayout"` — so
 * it cannot push the incoming page down while both are mounted.
 */
export function PagePan({
  panKey,
  direction,
  axis = "horizontal",
  enabled = true,
  children,
  className,
  contentClassName,
}: {
  /** Changing this starts a transition. */
  panKey: string;
  /** 1 pans in from the trailing edge, -1 from the leading edge. */
  direction: 1 | -1;
  /** Match the motion axis to the navigation control that initiated it. */
  axis?: "horizontal" | "vertical";
  /** Disabled key changes replace their content without retaining an outgoing page. */
  enabled?: boolean;
  children: ReactNode;
  className?: string;
  /** Size each incoming/outgoing page independently from the pan container. */
  contentClassName?: string;
}) {
  const scopeRef = useRef<HTMLDivElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const outgoingRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef<PanSnapshot>({ key: panKey, node: children });
  const [transition, setTransition] = useState<{
    renderedKey: string;
    outgoing: PanSnapshot | null;
    direction: 1 | -1;
    axis: "horizontal" | "vertical";
  }>({ renderedKey: panKey, outgoing: null, direction, axis });

  if (transition.renderedKey !== panKey) {
    const previous = committedRef.current;
    setTransition({
      renderedKey: panKey,
      outgoing: enabled ? previous : null,
      direction,
      axis,
    });
  } else if (!enabled && transition.outgoing) {
    setTransition({ ...transition, outgoing: null });
  }

  const outgoing = transition.renderedKey === panKey && enabled ? transition.outgoing : null;

  useLayoutEffect(() => {
    // An abandoned concurrent render must not advance the page snapshot. The
    // next transition always starts from content React actually committed.
    committedRef.current = { key: panKey, node: children };
  }, [children, panKey]);

  useLayoutEffect(() => {
    if (!enabled || !outgoing) return;
    const incoming = incomingRef.current;
    const leaving = outgoingRef.current;
    if (!incoming || !leaving) return;

    if (prefersReducedMotion()) {
      setTransition((current) =>
        current.outgoing === outgoing ? { ...current, outgoing: null } : current,
      );
      return;
    }

    const profile = motionProfile();
    const dir = transition.direction;
    const currentAxis = transition.axis;
    // The vertical route layer spans the clipped viewport exactly, so 100%
    // keeps the two pages edge-to-edge. Horizontal in-page pans retain the
    // profile's small gutter-clearing overtravel.
    const travel = currentAxis === "vertical" ? 100 : profile.tabTravel;
    const transform = (distance: number) =>
      currentAxis === "vertical"
        ? `translate3d(0, ${distance}%, 0)`
        : `translate3d(${distance}%, 0, 0)`;
    const incomingWillChange = incoming.style.willChange;
    const leavingWillChange = leaving.style.willChange;
    incoming.style.willChange = "transform";
    leaving.style.willChange = "transform";

    const incomingAnimation = incoming.animate(
      [{ transform: transform(dir * travel) }, { transform: transform(0) }],
      {
        duration: profile.enter.duration * 1000,
        easing: PAGE_PAN_EASING,
        fill: "both",
      },
    );
    const leavingAnimation = leaving.animate(
      [{ transform: transform(0) }, { transform: transform(-dir * travel) }],
      {
        duration: profile.exit.duration * 1000,
        easing: PAGE_PAN_EASING,
        fill: "both",
      },
    );

    let disposed = false;
    void Promise.all([incomingAnimation.finished, leavingAnimation.finished])
      .then(() => {
        if (disposed) return;
        // Persist the offscreen exit position before React synchronously drops
        // the old subtree. Some Android compositors otherwise paint the
        // animation's canceled origin for one frame during effect cleanup.
        try {
          leavingAnimation.commitStyles();
        } catch {
          // Older WebViews can lack commitStyles(); the synchronous removal
          // below still leaves no scheduled frame between cancel and unmount.
        }
        flushSync(() => {
          setTransition((current) =>
            current.outgoing === outgoing ? { ...current, outgoing: null } : current,
          );
        });
      })
      .catch(() => {
        // Cancellation is expected when navigation changes again mid-flight.
      });

    return () => {
      disposed = true;
      incomingAnimation.cancel();
      leavingAnimation.cancel();
      incoming.style.willChange = incomingWillChange;
      leaving.style.willChange = leavingWillChange;
    };
  }, [enabled, outgoing, panKey, transition.axis, transition.direction]);

  return (
    // `relative` positions the outgoing page, which leaves layout flow for the
    // length of the transition so it cannot displace the incoming one.
    <div
      ref={scopeRef}
      className={cn("relative h-full min-h-0 min-w-0", className)}
      data-slot="page-pan"
      data-axis={axis}
    >
      {outgoing && (
        <div
          ref={outgoingRef}
          key={outgoing.key}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 h-full min-h-0 min-w-0",
            contentClassName,
          )}
        >
          {outgoing.node}
        </div>
      )}
      <div
        ref={incomingRef}
        key={panKey}
        className={cn("relative h-full min-h-0 min-w-0", contentClassName)}
      >
        {children}
      </div>
    </div>
  );
}
