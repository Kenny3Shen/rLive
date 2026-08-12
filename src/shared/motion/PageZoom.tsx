import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { startTransition, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { EASE_OUT, motionProfile, prefersReducedMotion } from "./tokens";

const ROOM_ZOOM_START_SCALE = 0.96;

type ZoomSnapshot = {
  key: string;
  node: ReactNode;
  enabled: boolean;
};

/** Zooms into a room and keeps its live subtree mounted while zooming back out. */
export function PageZoom({
  zoomKey,
  enabled,
  children,
  className,
}: {
  /** Changing this restarts the transition when the destination is enabled. */
  zoomKey: string;
  enabled: boolean;
  children: ReactNode;
  className?: string;
}) {
  const scopeRef = useRef<HTMLDivElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const outgoingRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef<ZoomSnapshot>({
    key: zoomKey,
    node: children,
    enabled,
  });
  const [transition, setTransition] = useState<{
    renderedKey: string;
    outgoing: ZoomSnapshot | null;
  }>({ renderedKey: zoomKey, outgoing: null });

  if (transition.renderedKey !== zoomKey) {
    const previous = committedRef.current;
    setTransition({
      renderedKey: zoomKey,
      outgoing: previous.enabled && !enabled ? previous : null,
    });
  }

  const outgoing = transition.renderedKey === zoomKey ? transition.outgoing : null;

  useLayoutEffect(() => {
    // Refs mutated during render survive an abandoned concurrent render. Keep
    // the exit source tied to the page React actually committed instead.
    committedRef.current = { key: zoomKey, node: children, enabled };
  }, [children, enabled, zoomKey]);

  useGSAP(
    (_context, contextSafe) => {
      let releaseFrame: number | null = null;
      const releaseAfterFinalFrame = (callback: () => void) => {
        const release = () => {
          releaseFrame = null;
          callback();
        };
        const safeRelease = contextSafe?.(release) ?? release;
        releaseFrame = window.requestAnimationFrame(safeRelease);
      };

      if (outgoing) {
        const leaving = outgoingRef.current;
        if (!leaving) return;
        if (prefersReducedMotion()) {
          setTransition((current) =>
            current.outgoing === outgoing ? { ...current, outgoing: null } : current,
          );
          return;
        }

        const profile = motionProfile();
        gsap.set(leaving, {
          transformOrigin: "50% 50%",
          willChange: "transform,opacity",
        });
        gsap.to(leaving, {
          autoAlpha: 0,
          scale: ROOM_ZOOM_START_SCALE,
          duration: Math.min(profile.exit.duration, 0.18),
          ease: EASE_OUT,
          // This node is about to unmount. Clearing opacity/visibility here
          // would restore the live room for one frame before React removes it.
          onComplete: () => {
            releaseAfterFinalFrame(() => {
              startTransition(() => {
                setTransition((current) =>
                  current.outgoing === outgoing ? { ...current, outgoing: null } : current,
                );
              });
            });
          },
        });
        return () => {
          if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame);
        };
      }

      const incoming = incomingRef.current;
      if (!incoming || !enabled || prefersReducedMotion()) return;

      const profile = motionProfile();
      gsap.fromTo(
        incoming,
        {
          autoAlpha: 0,
          scale: ROOM_ZOOM_START_SCALE,
          transformOrigin: "50% 50%",
          willChange: "transform,opacity",
        },
        {
          autoAlpha: 1,
          scale: 1,
          duration: profile.enter.duration,
          ease: profile.enter.ease,
          onComplete: () => {
            releaseAfterFinalFrame(() => {
              gsap.set(incoming, {
                clearProps: "transform,transformOrigin,opacity,visibility,willChange",
              });
            });
          },
        },
      );

      return () => {
        if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame);
      };
    },
    {
      dependencies: [enabled, outgoing, zoomKey],
      scope: scopeRef,
      revertOnUpdate: true,
    },
  );

  return (
    <div
      ref={scopeRef}
      className={cn("relative flex h-full min-h-0 min-w-0", className)}
      data-slot="page-zoom"
      data-transitioning={outgoing ? "exit" : enabled ? "enter" : undefined}
    >
      {outgoing && (
        <div
          ref={outgoingRef}
          key={outgoing.key}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex min-h-0 min-w-0 bg-background"
        >
          {outgoing.node}
        </div>
      )}
      <div
        ref={incomingRef}
        key={zoomKey}
        className={cn(
          "relative flex h-full min-h-0 min-w-0 flex-1",
          outgoing && "pointer-events-none",
        )}
      >
        {children}
      </div>
    </div>
  );
}
