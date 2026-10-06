import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils";
import { FrozenRouter, RouterScope, useFrozenRouter } from "./FrozenRouter";
import { motionProfile, PAGE_PAN_PERCENT, prefersReducedMotion } from "./tokens";

type PanSnapshot = {
  key: string;
  node: ReactNode;
  /** 离场页面必须带着自己那一刻的路由上下文，见 `FrozenRouter`。 */
  router: FrozenRouter;
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
  // React 按 key 复用进出场节点。中断时记录当前合成位置，下一段从那里接手，
  // 而不是把还没走完的页面瞬移回 0 或屏外；只在中断时读样式，不逐帧采样。
  const interruptedTransforms = useRef(new WeakMap<HTMLElement, string>());
  const { location, route } = useFrozenRouter();
  // 上下文对象在路由变化时才换身份，因此可以用作快照副作用的依赖。
  const router = useMemo<FrozenRouter>(() => ({ location, route }), [location, route]);
  const committedRef = useRef<PanSnapshot>({ key: panKey, node: children, router });
  const [transition, setTransition] = useState<{
    renderedKey: string;
    outgoing: PanSnapshot | null;
    direction: 1 | -1;
    axis: "horizontal" | "vertical";
  }>({ renderedKey: panKey, outgoing: null, direction, axis });

  if (transition.renderedKey !== panKey) {
    setTransition({
      renderedKey: panKey,
      // 渲染期状态调整是 React 官方模式；committedRef 只在提交后的 layout effect
      // 里推进（见下），被丢弃的并发渲染不会污染它。规则无法表达这一刻意设计。
      // oxlint-disable-next-line react/refs
      outgoing: enabled ? committedRef.current : null,
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
    committedRef.current = { key: panKey, node: children, router };
  }, [children, panKey, router]);

  useLayoutEffect(() => {
    if (!enabled || !outgoing) {
      interruptedTransforms.current = new WeakMap();
      return;
    }
    const incoming = incomingRef.current;
    const leaving = outgoingRef.current;
    if (!incoming || !leaving) return;

    if (prefersReducedMotion()) {
      interruptedTransforms.current = new WeakMap();
      // 减少动态效果时不启动动画，同步清掉离场层，避免额外保留一帧。
      // oxlint-disable-next-line react/set-state-in-effect
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
    // 整面平移：两页作为一个连续视口一起移动。竖向不需要那道超行程：
    // 它不跑 PagePan 的水平裁切沟槽。
    const travel = currentAxis === "vertical" ? 100 : PAGE_PAN_PERCENT;
    const transform = (distance: number) =>
      currentAxis === "vertical"
        ? `translate3d(0, ${distance}%, 0)`
        : `translate3d(${distance}%, 0, 0)`;
    const incomingWillChange = incoming.style.willChange;
    const leavingWillChange = leaving.style.willChange;
    incoming.style.willChange = "transform";
    leaving.style.willChange = "transform";

    const resumeTransform = (element: HTMLElement, fallback: string) => {
      const previous = interruptedTransforms.current.get(element);
      interruptedTransforms.current.delete(element);
      return previous ?? fallback;
    };
    const leavingStart = resumeTransform(leaving, transform(0));
    // 全新目标页接在离场页旁边，快速连点时也不在两页之间拉出空白。
    const incomingStart = `${transform(dir * travel)} ${leavingStart === "none" ? "" : leavingStart}`;
    const incomingAnimation = incoming.animate(
      [{ transform: resumeTransform(incoming, incomingStart) }, { transform: transform(0) }],
      {
        duration: profile.enter.duration * 1000,
        easing: profile.enter.ease,
        fill: "both",
      },
    );

    const leavingAnimation = leaving.animate(
      [{ transform: leavingStart }, { transform: transform(-dir * travel) }],
      {
        duration: profile.exit.duration * 1000,
        easing: profile.exit.ease,
        fill: "both",
      },
    );

    let disposed = false;
    let completed = false;
    void Promise.all([incomingAnimation.finished, leavingAnimation.finished])
      .then(() => {
        if (disposed) return;
        completed = true;
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
      if (!completed) {
        for (const element of [incoming, leaving]) {
          if (element.isConnected) {
            interruptedTransforms.current.set(element, getComputedStyle(element).transform);
          }
        }
      }
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
          inert
          className={cn(
            "pointer-events-none absolute inset-0 h-full min-h-0 min-w-0",
            contentClassName,
          )}
        >
          <RouterScope value={outgoing.router}>{outgoing.node}</RouterScope>
        </div>
      )}
      <div
        ref={incomingRef}
        key={panKey}
        className={cn("relative h-full min-h-0 min-w-0", contentClassName)}
      >
        {/* 两侧必须是同一种包裹元素，React 才会把上一帧的层原样搬进离场位；
            详见 `RouterScope`。 */}
        <RouterScope value={router}>{children}</RouterScope>
      </div>
    </div>
  );
}
