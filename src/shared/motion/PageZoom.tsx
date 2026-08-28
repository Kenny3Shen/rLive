import { startTransition, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { clearMotionStyles } from "./tween";
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

  useLayoutEffect(() => {
    let disposed = false;
    let releaseFrame: number | null = null;
    const releaseAfterFinalFrame = (callback: () => void) => {
      const release = () => {
        releaseFrame = null;
        callback();
      };
      releaseFrame = window.requestAnimationFrame(release);
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
      const animations: Animation[] = [];

      // 离开房间就是倒放的进入：房间收缩回它长出来的缩放，
      // 目的地从它退到的反向缩放中扩张出来。两层各自一条补间、
      // 从时间 0 同时开始。该节点即将卸载，结束后不清理它的行内样式——
      // 恢复 opacity/visibility 会让活跃房间在 React 移除它之前重现一帧。
      leaving.style.willChange = "transform,opacity";
      leaving.style.transformOrigin = "50% 50%";
      animations.push(
        leaving.animate(
          [
            { opacity: 1, transform: "scale(1)" },
            { opacity: 0, transform: `scale(${ROOM_ZOOM_START_SCALE})` },
          ],
          {
            duration: duration * ROOM_ZOOM_EXIT_RATIO * 1000,
            easing: ease,
            fill: "both",
          },
        ),
      );

      if (incomingPage) {
        incomingPage.style.willChange = "transform,opacity";
        incomingPage.style.transformOrigin = "50% 50%";
        animations.push(
          incomingPage.animate(
            [
              { opacity: 0, transform: `scale(${ROOM_ZOOM_BACKDROP_SCALE})` },
              { opacity: 1, transform: "scale(1)" },
            ],
            { duration: duration * 1000, easing: ease, fill: "both" },
          ),
        );
      }

      // 等整段交叉淡化结束再卸载离开的房间，而不是等它自己较短的补间结束：
      // React 在过渡中途移除活跃播放器会表现为其后仍在动画的表面上的一次卡顿。
      void Promise.all(animations.map((animation) => animation.finished))
        .then(() => {
          if (disposed) return;
          releaseAfterFinalFrame(() => {
            // 撤销前先把结束帧固化为内联样式：leaving 的 opacity:0 若被 cancel
            // 直接撤销，会在 React 移除它之前的一两帧里以自然态（完全不透明）
            // 重新出现——表现为退出直播间时闪现残留画面（与 PagePan 的
            // commitStyles 同源问题）。
            for (const animation of animations) {
              try {
                animation.commitStyles();
              } catch {
                // 较旧 WebView 缺少 commitStyles()；保持 fill 持有。
              }
              animation.cancel();
            }
            if (incomingPage) clearMotionStyles(incomingPage);
            // 撤销离场层的 will-change 提升并等一帧合成：整页离场内容曾是一块
            // 独立合成层，React 移除子树的瞬间部分 WebView 会把该层的旧纹理
            // 再合成一两帧（表现为退出后闪现残留画面，即使它的 opacity 已为
            // 0）。先降级回普通绘制、让合成器在没有这层的状态下出一帧，
            // 再移除子树，销毁时就没有可闪的层。
            leaving.style.willChange = "";
            releaseAfterFinalFrame(() => startTransition(dropOutgoing));
          });
        })
        .catch(() => {
          // 导航中途再次变化时预期发生取消。
        });

      return () => {
        disposed = true;
        for (const animation of animations) animation.cancel();
        if (incomingPage) clearMotionStyles(incomingPage);
        if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame);
      };
    }

    const incoming = incomingRef.current;
    if (!incoming || !enabled || prefersReducedMotion()) return;

    const { duration, ease } = motionProfile().roomZoom;
    incoming.style.willChange = "transform,opacity";
    incoming.style.transformOrigin = "50% 50%";
    const animation = incoming.animate(
      [
        { opacity: 0, transform: `scale(${ROOM_ZOOM_START_SCALE})` },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: duration * 1000, easing: ease, fill: "both" },
    );
    void animation.finished
      .then(() => {
        if (disposed) return;
        releaseAfterFinalFrame(() => {
          animation.cancel();
          clearMotionStyles(incoming);
        });
      })
      .catch(() => {
        // 过渡中途被替换时预期发生取消。
      });

    return () => {
      disposed = true;
      animation.cancel();
      clearMotionStyles(incoming);
      if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame);
    };
  }, [enabled, outgoing, zoomKey]);

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
