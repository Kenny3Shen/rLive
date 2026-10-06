import {
  startTransition,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { RouterScope, useFrozenRouter, type FrozenRouter } from "./FrozenRouter";
import { clearMotionStyles } from "./tween";
import { motionProfile, prefersReducedMotion } from "./tokens";
import {
  readZoomOrigin,
  resolveZoomOrigin,
  zoomRectTransform,
  type PageZoomOrigin,
} from "./pageZoomOrigin";

/** 深链接和同路径换片没有可收回的来源窗口，保留轻量纵深反馈。 */
const ROOM_ZOOM_START_SCALE = 0.96;
const ROOM_ZOOM_BACKDROP_SCALE = 1.02;
const ORIGIN_MEMORY_LIMIT = 64;

type ZoomSnapshot = {
  key: string;
  node: ReactNode;
  enabled: boolean;
  origin: PageZoomOrigin | null;
  /** 离场页面必须带着自己那一刻的路由上下文，见 `FrozenRouter`。 */
  router: FrozenRouter;
};

/** 从来源窗口展开播放页，返回时让同一个活跃播放器缩回该窗口。 */
export function PageZoom({
  zoomKey,
  enabled,
  motionKey = zoomKey,
  direction = 1,
  children,
  className,
}: {
  /** 目的地启用时，改变它会重启过渡。 */
  zoomKey: string;
  enabled: boolean;
  /** 动画身份独立于挂载身份：同路径换视频可重播动画，但不重建播放器。 */
  motionKey?: string;
  /** 同一宿主内的历史返回由反向纵深浮现；跨宿主退出仍保留离场层。 */
  direction?: 1 | -1;
  children: ReactNode;
  className?: string;
}) {
  const scopeRef = useRef<HTMLDivElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const outgoingRef = useRef<HTMLDivElement>(null);
  const pendingOriginRef = useRef<{
    origin: PageZoomOrigin;
    entryKey: string;
    time: number;
  } | null>(null);
  const originMemoryRef = useRef(new Map<string, PageZoomOrigin | null>());
  const interruptedRef = useRef(new WeakMap<HTMLElement, Keyframe>());
  const lastEntryRef = useRef<string | null>(null);
  const { location: locationContext, route } = useFrozenRouter();
  const location = locationContext.location;
  // 上下文对象在路由变化时才换身份，因此可以用作快照副作用的依赖。
  const router = useMemo<FrozenRouter>(
    () => ({ location: locationContext, route }),
    [locationContext, route],
  );
  const committedRef = useRef<ZoomSnapshot>({
    key: zoomKey,
    node: children,
    enabled,
    origin: null,
    router,
  });
  const [transition, setTransition] = useState<{
    renderedKey: string;
    outgoing: ZoomSnapshot | null;
  }>({ renderedKey: zoomKey, outgoing: null });

  if (transition.renderedKey !== zoomKey) {
    setTransition({
      renderedKey: zoomKey,
      // 渲染期状态调整是 React 官方模式；committedRef 只在提交后的 layout effect
      // 里推进（见下），被丢弃的并发渲染不会污染它。规则无法表达这一刻意设计。
      // oxlint-disable-next-line react/refs
      outgoing: committedRef.current.enabled !== enabled ? committedRef.current : null,
    });
  }

  const outgoing = transition.renderedKey === zoomKey ? transition.outgoing : null;
  const page = `${location.pathname}${location.search}${location.hash}`;

  const captureOrigin = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => {
    if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
    pendingOriginRef.current = null;
    if (
      enabled ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    if ("button" in event && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest<HTMLElement>("[data-player-origin]");
    const control = target?.closest("button, a, input, select, textarea, [role=button]");
    const scope = scopeRef.current;
    // 卡内的收藏/菜单不是播放入口，不能污染随后一次程序导航的来源。
    if (!card || !scope?.contains(card) || (control && control !== card)) return;
    const origin = readZoomOrigin(card, scope, page);
    if (origin)
      pendingOriginRef.current = { origin, entryKey: location.key, time: performance.now() };
  };

  useLayoutEffect(() => {
    // 仅提交时推进快照与来源记忆；REPLACE 补参、同路径换片沿用外层入口。
    const previous = committedRef.current;
    const pending = pendingOriginRef.current;
    let origin: PageZoomOrigin | null = null;
    if (enabled) {
      origin = previous.enabled
        ? previous.origin
        : (originMemoryRef.current.get(location.key) ?? null);
      if (
        !previous.enabled &&
        pending?.entryKey === previous.router.location.location.key &&
        performance.now() - pending.time < 1500
      ) {
        origin = pending.origin;
      }
      originMemoryRef.current.set(location.key, origin);
      while (originMemoryRef.current.size > ORIGIN_MEMORY_LIMIT) {
        originMemoryRef.current.delete(originMemoryRef.current.keys().next().value!);
      }
    }
    if (previous.router.location.location.key !== location.key) pendingOriginRef.current = null;
    committedRef.current = { key: zoomKey, node: children, enabled, origin, router };
  }, [children, enabled, location.key, router, zoomKey]);

  useLayoutEffect(() => {
    let disposed = false;
    let settled = false;
    let frame: number | null = null;
    const animations: { element: HTMLElement; animation: Animation }[] = [];
    const nextFrame = (callback: () => void) => {
      frame = window.requestAnimationFrame(() => {
        frame = null;
        callback();
      });
    };
    const dropOutgoing = () => {
      setTransition((current) =>
        current.outgoing === outgoing ? { ...current, outgoing: null } : current,
      );
    };
    const incoming = incomingRef.current;
    const leaving = outgoingRef.current;
    const scope = scopeRef.current;
    if (!incoming || !scope) return;
    const exiting = !!outgoing?.enabled;
    if (!enabled) lastEntryRef.current = null;
    const entryKey = `${zoomKey}\u001f${motionKey}`;
    if (!exiting && (!enabled || lastEntryRef.current === entryKey)) return;
    if (!exiting) lastEntryRef.current = entryKey;

    // fixed 全屏舞台不能有 transformed ancestor；reduced-motion 直接落位。
    if (
      prefersReducedMotion() ||
      (document.fullscreenElement && scope.contains(document.fullscreenElement)) ||
      scope.querySelector('[data-player-stage][data-fullscreen="true"]')
    ) {
      if (outgoing) dropOutgoing();
      return;
    }

    const interruptedFrames = interruptedRef.current;
    const { duration, ease } = motionProfile().roomZoom;
    const animate = (element: HTMLElement, keyframes: Keyframe[]) => {
      const interrupted = interruptedFrames.get(element);
      interruptedFrames.delete(element);
      if (interrupted) keyframes[0] = interrupted;
      clearMotionStyles(element);
      element.style.willChange = "transform,opacity";
      element.style.transformOrigin = "50% 50%";
      const animation = element.animate(keyframes, {
        duration: duration * 1000,
        easing: ease,
        fill: "both",
      });
      animations.push({ element, animation });
    };
    const finish = () => {
      void Promise.all(animations.map(({ animation }) => animation.finished))
        .then(() => {
          if (disposed) return;
          nextFrame(() => {
            settled = true;
            // 离场先隐藏再 cancel，即使 WebView 没有 commitStyles 也不会闪回原画面。
            if (leaving) leaving.style.visibility = "hidden";
            for (const { element, animation } of animations) {
              animation.cancel();
              clearMotionStyles(element);
            }
            if (leaving) {
              leaving.style.visibility = "hidden";
              leaving.style.willChange = "";
              // 等合成器释放旧纹理，再卸载路由冻结的活跃 subtree。
              nextFrame(() => startTransition(dropOutgoing));
            }
          });
        })
        .catch(() => {
          /* 快速导航取消旧动画。 */
        });
    };

    if (exiting && leaving) {
      // 等 Shell 的 layout effect 恢复滚动后再读目标卡片，背景保持静止，
      // 避免缩回目标自身也在移动。离场仍保留原播放器及其旧路由参数。
      nextFrame(() => {
        const destination = committedRef.current.router.location.location;
        const rect = resolveZoomOrigin(
          outgoing.origin,
          `${destination.pathname}${destination.search}${destination.hash}`,
          incoming,
          scope,
        );
        const target = rect ? zoomRectTransform(rect) : `scale(${ROOM_ZOOM_START_SCALE})`;
        animate(leaving, [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0.9, offset: 0.75 },
          { opacity: 0, transform: target },
        ]);
        finish();
      });
    } else {
      // 只有从普通页展开才使用卡片来源；同路径换片仍复用唯一媒体节点。
      const origin = outgoing && !outgoing.enabled ? committedRef.current.origin : null;
      animate(incoming, [
        {
          opacity: origin ? 0.45 : 0,
          transform: origin
            ? zoomRectTransform(origin.rect)
            : `scale(${direction < 0 ? ROOM_ZOOM_BACKDROP_SCALE : ROOM_ZOOM_START_SCALE})`,
        },
        { opacity: 1, transform: "scale(1)" },
      ]);
      finish();
    }

    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      for (const { element, animation } of animations) {
        // React 按 key 原样移动节点。中断时只采样一次合成位置，反向从当前帧接管。
        if (!settled && element.isConnected) {
          const style = getComputedStyle(element);
          interruptedFrames.set(element, {
            transform: style.transform,
            opacity: style.opacity,
          });
        }
        animation.cancel();
        clearMotionStyles(element);
      }
      // StrictMode 的副作用重放需要重新启动；自然清理背景层则不能重播入场。
      if (!settled && !exiting) lastEntryRef.current = null;
    };
  }, [direction, enabled, motionKey, outgoing, zoomKey]);

  return (
    <div
      ref={scopeRef}
      className={cn("relative flex h-full min-h-0 min-w-0", className)}
      data-slot="page-zoom"
      data-transitioning={outgoing?.enabled ? "exit" : enabled ? "enter" : undefined}
      onClickCapture={captureOrigin}
      onKeyDownCapture={captureOrigin}
    >
      {outgoing && (
        <div
          ref={outgoingRef}
          key={outgoing.key}
          aria-hidden
          inert
          className={cn(
            "pointer-events-none absolute inset-0 flex min-h-0 min-w-0 bg-background",
            outgoing.enabled && "z-10",
          )}
        >
          <RouterScope value={outgoing.router}>{outgoing.node}</RouterScope>
        </div>
      )}
      <div
        ref={incomingRef}
        key={zoomKey}
        className={cn(
          "relative flex h-full min-h-0 min-w-0 flex-1",
          // 播放页盖住静止的来源列表，返回时则在列表上方缩走。
          outgoing && "bg-background",
          outgoing?.enabled && "pointer-events-none",
          outgoing && !outgoing.enabled && "z-10",
        )}
      >
        {/* 两侧必须是同一种包裹元素，React 才会把上一帧的层原样搬进离场位；
            详见 `RouterScope`。 */}
        <RouterScope value={router}>{children}</RouterScope>
      </div>
    </div>
  );
}
