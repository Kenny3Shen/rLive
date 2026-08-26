import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils";
import { EASE_OUT_CSS, motionProfile, prefersReducedMotion } from "./tokens";

// Web Animations 可以在 React 忙于主线程时由 Chromium 合成器推进这个 transform。
const PAGE_PAN_EASING = EASE_OUT_CSS;

type PanSnapshot = {
  key: string;
  node: ReactNode;
};

/**
 * 方向性页面平移，取代 `AnimatePresence` + variants。
 *
 * React 在子树离开元素树的瞬间卸载它，因此离场动画需要让离场内容在自己的移除
 * 之后继续存活。本组件在平移离场期间于 state 中保留上一个 child，然后丢弃它 ——
 * 即 `AnimatePresence` 曾提供的延迟卸载。
 *
 * 两个页面走过相同距离、相同方向、相同时长与缓动，且全程完全不透明：
 * 这一对读作一块连续表面在拇指下滑动，而不是交叉淡化。
 *
 * 过渡期间离场页脱离布局流（absolute, inset-0）—— 等价于 Motion 的
 * `mode="popLayout"` —— 使它在两页同时挂载时无法把进入页往下推。
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
  /** 改变它会启动一次过渡。 */
  panKey: string;
  /** 1 表示从尾侧进场，-1 从头侧进场。 */
  direction: 1 | -1;
  /** 让运动轴与发起导航的控件一致。 */
  axis?: "horizontal" | "vertical";
  /** 禁用的 key 变化直接替换内容，不保留离场页。 */
  enabled?: boolean;
  children: ReactNode;
  className?: string;
  /** 让进场/离场页相对平移容器独立设定尺寸。 */
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
    // 被放弃的并发渲染不得推进页面快照。下一次过渡总是从 React 真正提交的内容
    // 出发。
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
    // 垂直路由层恰好铺满裁剪视口，因此 100% 使两页贴合。页内水平平移保留
    // 配置中小小的清槽越冲量。
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
        // 在 React 同步丢弃旧子树之前持久化屏外离场位置。否则部分 Android 合成器
        // 会在副作用清理期间把动画被取消的起点画出一帧。
        try {
          leavingAnimation.commitStyles();
        } catch {
          // 较旧 WebView 可能缺少 commitStyles()；下方同步移除仍保证 cancel 与卸载之间
          // 没有排定的帧。
        }
        flushSync(() => {
          setTransition((current) =>
            current.outgoing === outgoing ? { ...current, outgoing: null } : current,
          );
        });
      })
      .catch(() => {
        // 导航中途再次变化时预期发生取消。
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
    // `relative` 为离场页定位，它在过渡期间脱离布局流，
    // 从而不会挤动进入页。
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
