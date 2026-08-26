import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { startTransition, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { motionProfile, prefersReducedMotion } from "./tokens";

/**
 * 沉浸页进入时的起始缩放，退出时回归的目标。
 *
 * 两个方向共用它，使过渡成为一段可正向也可反向解读的运动：进入时房间从 0.96
 * 长到 1、浏览列表退去；离开时房间缩回 0.96、列表浮现。若退出反而放大，
 * 会被读作第二次无关的推入。
 */
const ROOM_ZOOM_START_SCALE = 0.96;
/**
 * 房间在其上方缩走时目的地由该缩放浮现。
 *
 * 只有退出才有第二层要动：房间的活跃子树在退出期间被保留正是为了让它可以动画，
 * 而进入时浏览列表立即卸载、房间是屏幕上唯一的表面。
 *
 * 刻意比 `ROOM_ZOOM_START_SCALE` 更接近 1。目的地是背景而不是主角，
 * 给它与离开房间相同的行程会让两层看似移动同样距离，
 * 抹平缩放想表达的纵深感。
 */
const ROOM_ZOOM_BACKDROP_SCALE = 1.02;
/**
 * 离场页用于淡出的过渡占比。
 *
 * 退出补间比进入短以便两者重叠：旧页清场时新页已在浮现，
 * 而不是视口在两页之间穿过一帧完全空白。
 */
const ROOM_ZOOM_EXIT_RATIO = 0.72;

type ZoomSnapshot = {
  key: string;
  node: ReactNode;
  enabled: boolean;
};

/** 缩放进入房间，缩放退出期间保持其活跃子树挂载。 */
export function PageZoom({
  zoomKey,
  enabled,
  children,
  className,
}: {
  /** 目的地启用时，改变它会重启过渡。 */
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
    // 渲染期间修改的 refs 能在被放弃的并发渲染中幸存。让退出来源绑定到 React
    // 实际提交的那一页。
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

        // 离开房间就是倒放的进入：房间收缩回它长出来的缩放，
        // 目的地从它退到的反向缩放中扩张出来。
        timeline.fromTo(
          leaving,
          { autoAlpha: 1, scale: 1, transformOrigin: "50% 50%", willChange: "transform,opacity" },
          {
            autoAlpha: 0,
            scale: ROOM_ZOOM_START_SCALE,
            duration: duration * ROOM_ZOOM_EXIT_RATIO,
            ease,
            // 该节点即将卸载。在这里清除 opacity/visibility 会让活跃房间在 React 移除它
            // 之前重现一帧。
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

        // 等整段交叉淡化结束再卸载离开的房间，而不是等它自己较短的补间结束：
        // React 在时间轴中途移除活跃播放器会表现为其后仍在动画的表面上的一次卡顿。
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
          // 退出期间本页在离开房间下方从透明淡入，因此需要自己的底层：
          // 没有它，交叉淡化期间房间会透过目的地一直可见。
          outgoing && "pointer-events-none bg-background",
        )}
      >
        {children}
      </div>
    </div>
  );
}
