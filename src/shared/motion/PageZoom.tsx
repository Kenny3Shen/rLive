import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { startTransition, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { motionProfile, prefersReducedMotion } from "./tokens";

/**
 * Scale the immersive page starts from when entering, and returns to on exit.
 *
 * Both directions share it so the transition is one motion read forwards or
 * backwards: entering, the room grows from 0.96 to 1 as the browse list falls
 * away; leaving, the room shrinks back to 0.96 as the list resolves. An exit
 * that scaled *up* instead would read as a second, unrelated push.
 */
const ROOM_ZOOM_START_SCALE = 0.96;
/**
 * Scale the destination resolves from while a room zooms away above it.
 *
 * Only the exit has a second layer to move: the room's live subtree is retained
 * during exit precisely so it can animate, whereas entering unmounts the browse
 * list immediately and leaves the room as the only surface on screen.
 *
 * Kept much nearer 1 than `ROOM_ZOOM_START_SCALE`. The destination is context
 * rather than the subject, and giving it the same travel as the leaving room
 * made both layers read as moving the same distance, which flattened the depth
 * the zoom exists to convey.
 */
const ROOM_ZOOM_BACKDROP_SCALE = 1.02;
/**
 * Share of the transition the outgoing page spends fading.
 *
 * The exit tween runs shorter than the enter so the two overlap: the incoming
 * page is already resolving while the old one clears, instead of the viewport
 * passing through a fully blank frame between them.
 */
const ROOM_ZOOM_EXIT_RATIO = 0.72;

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

      const dropOutgoing = () => {
        setTransition((current) =>
          current.outgoing === outgoing ? { ...current, outgoing: null } : current,
        );
      };

      if (outgoing) {
        const leaving = outgoingRef.current;
        if (!leaving) return;
        if (prefersReducedMotion()) {
          dropOutgoing();
          return;
        }

        const { duration, ease } = motionProfile().roomZoom;
        const incomingPage = incomingRef.current;
        const timeline = gsap.timeline();

        // Leaving a room is the enter played backwards: the room contracts to
        // the scale it grew from while the destination expands out of the
        // counter-scale it receded to.
        timeline.fromTo(
          leaving,
          { autoAlpha: 1, scale: 1, transformOrigin: "50% 50%", willChange: "transform,opacity" },
          {
            autoAlpha: 0,
            scale: ROOM_ZOOM_START_SCALE,
            duration: duration * ROOM_ZOOM_EXIT_RATIO,
            ease,
            // This node is about to unmount. Clearing opacity/visibility here
            // would restore the live room for one frame before React removes it.
          },
          0,
        );

        if (incomingPage) {
          timeline.fromTo(
            incomingPage,
            {
              autoAlpha: 0,
              scale: ROOM_ZOOM_BACKDROP_SCALE,
              transformOrigin: "50% 50%",
              willChange: "transform,opacity",
            },
            {
              autoAlpha: 1,
              scale: 1,
              duration,
              ease,
              onComplete: () => {
                releaseAfterFinalFrame(() => {
                  gsap.set(incomingPage, {
                    clearProps: "transform,transformOrigin,opacity,visibility,willChange",
                  });
                });
              },
            },
            0,
          );
        }

        // Unmount the leaving room once the whole crossfade is done, not when
        // its own shorter tween ends: React removing a live player mid-timeline
        // is visible as a hitch in the surface still animating behind it.
        timeline.eventCallback("onComplete", () => {
          releaseAfterFinalFrame(() => {
            startTransition(dropOutgoing);
          });
        });

        return () => {
          timeline.kill();
          if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame);
        };
      }

      const incoming = incomingRef.current;
      if (!incoming || !enabled || prefersReducedMotion()) return;

      const { duration, ease } = motionProfile().roomZoom;
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
          duration,
          ease,
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
          // During an exit this page fades up from transparent underneath the
          // leaving room, so it needs its own ground: without it the room stays
          // visible through the destination for the length of the crossfade.
          outgoing && "pointer-events-none bg-background",
        )}
      >
        {children}
      </div>
    </div>
  );
}
