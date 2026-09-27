import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  hasLongPressMovedBeyondSlop,
  LONG_PRESS_SPEED_RATE,
  LONG_PRESS_TRIGGER_MS,
} from "@/shared/gestures/longPress";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import {
  SHORTS_SWIPE_SETTLE_EASING,
  SHORTS_SWIPE_VELOCITY_WINDOW_MS,
  shortsPanelDepth,
  shortsSwipeDragOffset,
  shortsSwipeIntent,
  shortsSwipeSettleDuration,
  shortsSwipeTargetIndex,
  shortsSwipeVelocity,
  shortsTrackOffset,
  type ShortsSwipeSample,
} from "./shortsFeed";
import type { ShortsPlaybackState } from "./useShortsPlayback";

/**
 * 长按倍速释放后封锁点按的时长（ms）。
 *
 * 与播放页的 `SURFACE_TAP_SUPPRESSION_MS` 同量级：抬手后到达的延迟 click 必须落在这段里
 * 被否决，否则每次倍速松手都会顺手把视频暂停。
 */
const SHORTS_TAP_SUPPRESSION_MS = 300;

type ShortsInteractionOptions = {
  items: readonly unknown[];
  index: number;
  setIndex: (index: number) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
  trackRef: RefObject<HTMLDivElement | null>;
  playback: Pick<ShortsPlaybackState, "loading" | "error" | "paused" | "setRate" | "togglePlay">;
  navigationLocked: boolean;
  blocked: boolean;
  onMotionActiveChange: (active: boolean) => void;
  noteDirection: (from: number, to: number) => void;
  onBoundary?: (next: number) => void;
};

/** 平台无关的短视频交互：长按倍速、纵向翻页、滚轮与键盘共用同一条管线。 */
export function useShortsInteraction({
  items,
  index,
  setIndex,
  viewportRef,
  trackRef,
  playback,
  navigationLocked,
  blocked,
  onMotionActiveChange,
  noteDirection,
  onBoundary,
}: ShortsInteractionOptions) {
  const [gestureActive, setGestureActive] = useState(false);

  /* ---------- 长按倍速 ---------- */

  /**
   * 按住画面临时倍速，松手回 1x —— 与播放页同一套语义、同一组常量
   * （`LONG_PRESS_SPEED_RATE` / `LONG_PRESS_TRIGGER_MS`），因此两个表面上的手感一致。
   *
   * 挂在页面这条 pointer 管线里而不是另起一个识别器：换片手势会
   * `setPointerCapture` 并 `stopPropagation`，另挂一套的取消路径会失明（与卡片长按
   * 必须镜像到 window 捕获阶段是同一个原因）。位移容忍半径
   * （`LONG_PRESS_CANCEL_SLOP_PX`，10px）小于换片锁定距离
   * （`SHORTS_SWIPE_LOCK_DISTANCE_PX`，12px），因此能锁成换片的手势必定先取消倍速，
   * 不会出现「倍速中又换了片」。
   */
  const speedPressRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const speedHoldTimerRef = useRef<number | null>(null);
  const speedHoldActiveRef = useRef(false);
  /** 倍速释放后短暂封锁点按：抬手后可能补发一次 click，那一下不该切暂停。 */
  const suppressTapUntilRef = useRef(0);
  /**
   * 计时器到期时才读的资格。
   *
   * 不在按下时闭包捕获：按下与触发相隔 500ms，这段时间里取流可能刚好完成，也可能
   * 刚好失败。按下那一刻的判断到期时已经过时。
   */
  const speedEligibleRef = useRef(false);
  useLayoutEffect(() => {
    speedEligibleRef.current = !playback.loading && !playback.error && !playback.paused;
  }, [playback.error, playback.loading, playback.paused]);

  const setRate = playback.setRate;

  const releaseSpeedHold = useCallback(() => {
    if (speedHoldTimerRef.current !== null) {
      window.clearTimeout(speedHoldTimerRef.current);
      speedHoldTimerRef.current = null;
    }
    speedPressRef.current = null;
    if (!speedHoldActiveRef.current) return;
    speedHoldActiveRef.current = false;
    suppressTapUntilRef.current = Date.now() + SHORTS_TAP_SUPPRESSION_MS;
    setRate(1);
  }, [setRate]);

  const armSpeedHold = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      releaseSpeedHold();
      // 只认领画面框上的按压：框外是背景区与两条控制栏，按住它们不该改变播放速度
      // （点按暂停层也只铺画面框，两者的命中范围刻意一致）。
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[data-slot="shorts-frame"]')
      ) {
        return;
      }
      speedPressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      speedHoldTimerRef.current = window.setTimeout(() => {
        speedHoldTimerRef.current = null;
        if (!speedPressRef.current || !speedEligibleRef.current) return;
        speedHoldActiveRef.current = true;
        // 立即封锁点按：倍速期间手指仍在画面上，中途任何补发的 click 都不该切暂停。
        suppressTapUntilRef.current = Date.now() + SHORTS_TAP_SUPPRESSION_MS;
        setRate(LONG_PRESS_SPEED_RATE);
      }, LONG_PRESS_TRIGGER_MS);
    },
    [releaseSpeedHold, setRate],
  );

  /** 手指漂移出容忍半径即取消：那是一次滑动（换片或误触），不是长按。 */
  const trackSpeedHoldMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = speedPressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      if (hasLongPressMovedBeyondSlop(press.x, press.y, event.clientX, event.clientY)) {
        releaseSpeedHold();
      }
    },
    [releaseSpeedHold],
  );

  /**
   * 抬手一律在 window 捕获阶段收：指针可能在视口外结束（桌面把鼠标拖出窗口再松），
   * Android WebView 也有丢 `pointercancel` 的先例。漏一次就会把 3x 永久留在画面上，
   * 而界面上除了换片没有别的出口。
   */
  useEffect(() => {
    const onEnd = () => releaseSpeedHold();
    window.addEventListener("pointerup", onEnd, true);
    window.addEventListener("pointercancel", onEnd, true);
    return () => {
      window.removeEventListener("pointerup", onEnd, true);
      window.removeEventListener("pointercancel", onEnd, true);
      releaseSpeedHold();
    };
  }, [releaseSpeedHold]);

  /**
   * 画面点按：切播放/暂停。
   *
   * 决定权归页面而不是舞台：长按倍速的抬手会补发一次 click，只有这一层知道刚才那次
   * 按压已经被倍速认领了。
   */
  const onSurfaceTap = useCallback(() => {
    if (Date.now() < suppressTapUntilRef.current) return;
    playback.togglePlay();
  }, [playback]);

  /* ---------- 纵向翻页：手指按下期间直接写 transform，释放交给合成器 ---------- */

  const offsetRef = useRef(0);
  const animationRef = useRef<Animation | null>(null);
  /**
   * 收尾动画是否在跑。
   *
   * 换片提交时 `parkTrack` 会因 `index` 变化重跑；若它照常取消动画，就会把刚启动的
   * 收尾取消成一次硬切（正是「先瞬间切换、再滑一下」的根因）。它期间必须让位。
   */
  const settlingRef = useRef(false);
  const stageHeightRef = useRef(0);
  /**
   * 每个面板的纵深基准。
   *
   * 面板的 `top` 是绝对下标 × 舞台高，而条带在平移，因此「离视口中心多远」是
   * `offset + top`。拖动开始与每次停靠时重采：面板集合会随换片增减，高度会随旋转变化。
   */
  const depthPanelsRef = useRef<{ el: HTMLElement; top: number }[]>([]);
  const depthAnimationsRef = useRef<Animation[]>([]);
  /** 本手势内是否要跳过纵深（系统设置）。在采样时定下，不在每帧重读 matchMedia。 */
  const depthReducedRef = useRef(false);
  const swipeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startOffset: number;
    stageHeight: number;
    index: number;
    length: number;
    /** 已锁定为纵向手势。锁定前不移动条带，也不拦子元素的点按。 */
    vertical: boolean;
    samples: ShortsSwipeSample[];
  } | null>(null);

  // 轴锁前尚未 capture 指针，抬手可能落在视口外；不能把分页接入门永久锁住。
  useEffect(() => {
    const finishPending = (event: PointerEvent) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId || swipe.vertical) return;
      swipeRef.current = null;
      if (!settlingRef.current) onMotionActiveChange(false);
    };
    window.addEventListener("pointerup", finishPending, true);
    window.addEventListener("pointercancel", finishPending, true);
    return () => {
      window.removeEventListener("pointerup", finishPending, true);
      window.removeEventListener("pointercancel", finishPending, true);
    };
  }, [onMotionActiveChange]);

  const stageHeight = useCallback(() => {
    const measured = viewportRef.current?.clientHeight ?? 0;
    if (measured > 0) stageHeightRef.current = measured;
    return stageHeightRef.current;
  }, [viewportRef]);

  const writeOffset = useCallback(
    (offset: number) => {
      offsetRef.current = offset;
      const el = trackRef.current;
      if (el) el.style.transform = `translate3d(0, ${offset}px, 0)`;
    },
    [trackRef],
  );

  /** 重采面板的纵深基准（拖动锁定、停靠、尺寸变化时）。 */
  const collectDepthPanels = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    depthReducedRef.current = prefersReducedMotion();
    depthPanelsRef.current = Array.from(
      track.querySelectorAll<HTMLElement>('[data-slot="shorts-panel"]'),
    ).map((el) => ({ el, top: el.offsetTop }));
  }, [trackRef]);

  /**
   * 把纵深写进每个面板的内联样式。
   *
   * 只碰 `transform` 与 `opacity`：拖动期间每个 pointermove 都会走这里，写成别的属性
   * 会拉着布局一起重算。系统开启「减弱动态效果」时不写任何缩放，构图保持原样。
   */
  /* oxlint-disable react/immutability */
  const writeDepth = useCallback(
    (offset: number) => {
      const height = stageHeight();
      if (!(height > 0)) return;
      const reduced = depthReducedRef.current;
      for (const panel of depthPanelsRef.current) {
        if (reduced) {
          panel.el.style.transform = "";
          panel.el.style.opacity = "";
          continue;
        }
        const depth = shortsPanelDepth(Math.abs(offset + panel.top) / height);
        // 恒等值用空字符串表达：静止时不给正在看的那条平白加一层 stacking context，
        // 也不会因 `scale(1)` 之外的写入让 React 的样式 diff 多一项。
        panel.el.style.transform = depth.scale === 1 ? "" : `scale(${depth.scale})`;
        panel.el.style.opacity = depth.opacity === 1 ? "" : String(depth.opacity);
      }
    },
    [stageHeight],
  );
  /* oxlint-enable react/immutability */

  /** 拖动中的每帧路径：条带平移与面板纵深一起写。 */
  const writePlacement = useCallback(
    (offset: number) => {
      writeOffset(offset);
      writeDepth(offset);
    },
    [writeDepth, writeOffset],
  );

  /** 在当前位置停止收尾，把该偏移留下作为内联样式。 */
  const cancelSettle = useCallback(() => {
    settlingRef.current = false;
    const depthAnimations = depthAnimationsRef.current;
    if (depthAnimations.length > 0) {
      depthAnimationsRef.current = [];
      // 不在中途提交纵深值：下一次 writeDepth / 手势会按同一 offset 重写，比取矩阵可靠。
      for (const animation of depthAnimations) animation.cancel();
    }
    const animation = animationRef.current;
    if (!animation) return;
    const el = trackRef.current;
    let stoppedAt = offsetRef.current;
    if (el) {
      const computed = window.getComputedStyle(el).transform;
      if (computed && computed !== "none") {
        try {
          stoppedAt = new DOMMatrixReadOnly(computed).m42;
        } catch {
          // 取不到实时矩阵时退回记账值：比跳到终点温和。
        }
      }
    }
    animationRef.current = null;
    writeOffset(stoppedAt);
    animation.cancel();
  }, [trackRef, writeOffset]);

  /**
   * 纵深收尾动画。
   *
   * 按每个面板**自己的**距离分别补间，而不是把条带整体缩放：那样会让正在看的这条也跟
   * 着缩一下。面板集合按开始时的快照取值（`depthPanelsRef`），因为这条动画要跨过
   * `setIndex` 的那次提交 —— 提交只改 `top`，不动我们已经写在面板上的内联样式。
   *
   * 在 `settle` 之前声明：后者引用它。
   */
  const animateDepth = useCallback(
    (from: number, target: number, duration: number): Animation[] => {
      const height = stageHeight();
      // 注意：`reduced` 在采集时已定，若中途切换系统设置则这一步动画仍会起，但下一次
      // 停靠/拖动就会回到原样——比每帧重读 matchMedia 便宜。
      if (!(height > 0) || depthReducedRef.current) return [];
      const animations: Animation[] = [];
      for (const panel of depthPanelsRef.current) {
        const at = (offset: number) => shortsPanelDepth(Math.abs(offset + panel.top) / height);
        const start = at(from);
        const end = at(target);
        animations.push(
          panel.el.animate(
            [
              { transform: `scale(${start.scale})`, opacity: start.opacity },
              { transform: `scale(${end.scale})`, opacity: end.opacity },
            ],
            { duration, easing: SHORTS_SWIPE_SETTLE_EASING, fill: "both" },
          ),
        );
      }
      depthAnimationsRef.current = animations;
      return animations;
    },
    [stageHeight],
  );

  /**
   * 把剩余行程交给合成器。
   *
   * 刻意用 Web Animations 而不是 rAF 补间：换片会触发一次 React 提交（拆旧播放器、
   * 建新播放器），主线程上的补间会被那次提交吞掉大部分帧 —— 那正是「先瞬间切换、
   * 再滑一下」的观感来源。`fill: both` 让第一个关键帧立即生效，条带不会绘制出
   * 未变换的一帧。
   *
   * 面板纵深用等长同缓动的第二条动画一起跑：条带平移与缩放淡出必须同时到达，否则
   * 会看到画面先滑到位再「啪」地缩一下。
   */
  const settle = useCallback(
    (target: number, duration: number) => {
      const el = trackRef.current;
      if (!el) return;
      cancelSettle();
      // 面板集合与高度可能在上一轮换片/旋转后变了：收尾前重采一次，纵深动画才有正确的基准。
      collectDepthPanels();
      const from = offsetRef.current;
      if (duration <= 0 || from === target || prefersReducedMotion()) {
        settlingRef.current = false;
        onMotionActiveChange(false);
        offsetRef.current = target;
        el.style.transform = `translate3d(0, ${target}px, 0)`;
        el.style.willChange = "";
        // 瞬时路径没有动画，纵深必须直接落到位，否则会停在上一手势的中间值。
        writeDepth(target);
        return;
      }
      settlingRef.current = true;
      onMotionActiveChange(true);
      offsetRef.current = target;
      el.style.willChange = "transform";
      const animation = el.animate(
        [
          { transform: `translate3d(0, ${from}px, 0)` },
          { transform: `translate3d(0, ${target}px, 0)` },
        ],
        { duration, easing: SHORTS_SWIPE_SETTLE_EASING, fill: "both" },
      );
      animationRef.current = animation;
      const depthAnimations = animateDepth(from, target, duration);
      void animation.finished
        .then(() => {
          if (animationRef.current !== animation) return;
          animationRef.current = null;
          settlingRef.current = false;
          onMotionActiveChange(false);
          // 先写内联样式再取消动画：顺序颠倒会让部分 Android 合成器画出一帧未变换的层。
          el.style.transform = `translate3d(0, ${target}px, 0)`;
          animation.cancel();
          el.style.willChange = "";
        })
        .catch(() => {
          // 新手势或新下标打断时预期会取消。
        });
      void Promise.all(depthAnimations.map((item) => item.finished.catch(() => undefined))).then(
        () => {
          if (depthAnimationsRef.current !== depthAnimations) return;
          depthAnimationsRef.current = [];
          // 同样先写内联再取消，避免最后一帧回退成未缩放的构图。
          writeDepth(target);
          for (const item of depthAnimations) item.cancel();
        },
      );
    },
    [animateDepth, cancelSettle, collectDepthPanels, onMotionActiveChange, trackRef, writeDepth],
  );

  /** 把条带停靠在当前下标处，不做运动（挂载、尺寸变化、下标被外部改动）。 */
  const parkTrack = useCallback(() => {
    if (swipeRef.current?.vertical) return;
    // 收尾进行中就让它跑到终点：这里取消动画会变成一次硬切（目标与收尾目标相同）。
    if (settlingRef.current) return;
    cancelSettle();
    const target = shortsTrackOffset(index, stageHeight());
    collectDepthPanels();
    writeOffset(target);
    writeDepth(target);
    const el = trackRef.current;
    if (el) el.style.willChange = "";
  }, [cancelSettle, collectDepthPanels, index, stageHeight, trackRef, writeDepth, writeOffset]);

  useLayoutEffect(() => {
    parkTrack();
  }, [items, parkTrack]);

  // 视口高度变化（旋转、系统栏、软键盘）要重建纵向基准，否则第一条之后的
  // 条目会整个被推出屏幕。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    // 初值取当前高度，而不是 0：这条 effect 依赖 `index`，每次换片都会重建观察器，
    // 而观察器首次回调几乎必然带着「和现在一样」的高度。若从 0 起步，那次回调会被
    // 当成一次真实的高度变化，恰好落在刚启动的收尾上把它取消成硬切 —— 正是这个 bug
    // 的主因。取当前高度后，首次回调自然是无操作。
    let applied = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = viewport.clientHeight;
      // 只有高度变化才重建：手势与收尾进行中一律不动，避免把运行中的动画跳到终点。
      if (height <= 0 || height === applied || swipeRef.current?.vertical) return;
      if (settlingRef.current) return;
      applied = height;
      stageHeightRef.current = height;
      cancelSettle();
      collectDepthPanels();
      writeOffset(shortsTrackOffset(index, height));
      writeDepth(shortsTrackOffset(index, height));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [cancelSettle, collectDepthPanels, index, viewportRef, writeDepth, writeOffset]);

  useEffect(
    () => () => {
      const animation = animationRef.current;
      animationRef.current = null;
      animation?.cancel();
      for (const depthAnimation of depthAnimationsRef.current) depthAnimation.cancel();
      depthAnimationsRef.current = [];
    },
    [],
  );

  /**
   * 跳到某一条：已挂载的目的条先开始平移，再通知 React。
   *
   * 顺带记下滑动方向：预热槽位按它决定去预热哪一条邻居（`useShortsSlots`）。
   * 放在这里而不是页面别处，是因为所有换片入口（手势、滚轮、方向键、桌面按钮）
   * 都汇聚到这个函数 —— 方向因此不可能漏记。
   */
  const goToIndex = useCallback(
    (next: number, velocity = 0) => {
      if (navigationLocked) return;
      if (next < 0 || next >= items.length) {
        onBoundary?.(next);
        return;
      }
      if (next === index) return;
      noteDirection(index, next);
      const target = shortsTrackOffset(next, stageHeight());
      settle(target, shortsSwipeSettleDuration(target - offsetRef.current, velocity));
      setIndex(next);
    },
    [
      navigationLocked,
      index,
      items.length,
      noteDirection,
      onBoundary,
      setIndex,
      settle,
      stageHeight,
    ],
  );

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 浮层打开时不认领新按压；已有手势仍走原来的移动、取消与释放路径。
      if (blocked) return;
      const pointerType = event.pointerType as string;
      // 进度条上的按压归它自己：那是唯一的横向精细操作，纵向抖动不该换片。
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-slot="shorts-seek"]')
      ) {
        return;
      }
      // 长按倍速先于换片武装：它对鼠标也成立（桌面按住画面同样倍速），而下面那段换片
      // 只收手指。两者共用同一次按压：位移超过容忍半径时倍速自己取消（见
      // `trackSpeedHoldMove`），不需要在这里分他们的胜负。
      armSpeedHold(event);
      // 部分 Android WebView 对手指输入上报空的 pointerType。鼠标不参与换片
      // （桌面用滚轮与方向键，见下）。
      if ((pointerType !== "touch" && pointerType !== "") || !event.isPrimary || navigationLocked)
        return;
      onMotionActiveChange(true);
      // 这是页面级换片手势的起点：面板此刻的纵深基准就是「用手势接管之前」的静态画像，
      // 必须在这里采。一旦开始拖动，`offsetTop` 会被条带平移影响（这里读到的仍是布局值，
      // 但集合本身会在换片提交时增减），所以基准就该在按下时定下。
      collectDepthPanels();
      swipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        // 临时值：收尾可能仍在跑，其达到的偏移只在锁定为纵向时才读。
        startOffset: offsetRef.current,
        stageHeight: stageHeight() || event.currentTarget.clientHeight,
        index,
        length: items.length,
        vertical: false,
        samples: [{ y: event.clientY, time: performance.now() }],
      };
    },
    [
      armSpeedHold,
      blocked,
      collectDepthPanels,
      navigationLocked,
      index,
      items.length,
      onMotionActiveChange,
      stageHeight,
    ],
  );

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 先算倍速的取消：鼠标没有 `swipeRef`，下一行就返回了。
      trackSpeedHoldMove(event);
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - swipe.startX;
      const deltaY = event.clientY - swipe.startY;

      if (!swipe.vertical) {
        const intent = shortsSwipeIntent(deltaX, deltaY);
        if (intent === "pending") return;
        if (intent === "reject") {
          swipeRef.current = null;
          if (!settlingRef.current) onMotionActiveChange(false);
          return;
        }
        swipe.vertical = true;
        setGestureActive(true);
        // 从收尾到达的精确像素接管，过渡中途抓住条带从那里继续而不是跳变。
        cancelSettle();
        swipe.startOffset = offsetRef.current;
        const el = trackRef.current;
        // 只有确认纵向后才提升层；面板的纵深基准也在这一刻采一次（集合与高度都还新鲜）。
        if (el) el.style.willChange = "transform";
        collectDepthPanels();
        // 指针捕获是增强而不是前提：`touchAction: pan-x` 已经把纵向移动交给我们，
        // 捕获只是让手指滑出元素后仍然收到事件。它会在指针已经结束时抛
        // NotFoundError（Android WebView 上真实发生过），不接住的话这一帧剩下的
        // 采样重置、偏移写入与 preventDefault 全部被跳过。
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // 没有捕获也能继续：事件仍然到达这个元素，只是滑出边界后可能中断。
        }
        // 从锁定点重启采样：锁定前的样本描述的是还没被认作换片的手势。
        swipe.samples = [];
      }

      swipe.samples.push({ y: event.clientY, time: performance.now() });
      if (swipe.samples.length > 8) swipe.samples.shift();
      writePlacement(
        swipe.startOffset +
          shortsSwipeDragOffset(swipe.index, swipe.length, deltaY, swipe.stageHeight),
      );
      // 阻止子元素把这当作滚动或拖拽。
      event.preventDefault();
      event.stopPropagation();
    },
    [
      cancelSettle,
      collectDepthPanels,
      onMotionActiveChange,
      trackRef,
      trackSpeedHoldMove,
      writePlacement,
    ],
  );

  const finishSwipe = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      swipeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!swipe.vertical) {
        if (!settlingRef.current) onMotionActiveChange(false);
        return;
      }
      setGestureActive(false);

      if (cancelled) {
        const target = shortsTrackOffset(swipe.index, swipe.stageHeight);
        settle(target, shortsSwipeSettleDuration(target - offsetRef.current, 0));
        return;
      }

      swipe.samples.push({ y: event.clientY, time: performance.now() });
      const velocity = shortsSwipeVelocity(swipe.samples, SHORTS_SWIPE_VELOCITY_WINDOW_MS);
      const dragOffset = offsetRef.current - swipe.startOffset;
      const next = shortsSwipeTargetIndex(
        swipe.index,
        swipe.length,
        dragOffset,
        velocity,
        swipe.stageHeight,
      );
      event.preventDefault();
      event.stopPropagation();
      if (next === null) {
        const target = shortsTrackOffset(swipe.index, swipe.stageHeight);
        settle(target, shortsSwipeSettleDuration(target - offsetRef.current, velocity));
        return;
      }
      // 先开始收尾再通知 React：换片的提交（拆旧播放器、建新播放器）不该插在
      // 手指抬起与第一个动画帧之间。
      const target = shortsTrackOffset(next, swipe.stageHeight);
      settle(target, shortsSwipeSettleDuration(target - offsetRef.current, velocity));
      setIndex(next);
    },
    [onMotionActiveChange, setIndex, settle],
  );

  const onPointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => finishSwipe(event, false),
    [finishSwipe],
  );
  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => finishSwipe(event, true),
    [finishSwipe],
  );

  /* ---------- 桌面：滚轮与键盘 ---------- */

  const wheelLockRef = useRef(0);
  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (blocked) return;
      if (Math.abs(event.deltaY) < 4) return;
      const now = performance.now();
      // 惯性滚轮一次手势会发几十个事件，一次只走一条。
      if (now < wheelLockRef.current) return;
      wheelLockRef.current = now + 420;
      goToIndex(index + (event.deltaY > 0 ? 1 : -1));
    },
    [blocked, goToIndex, index],
  );

  /**
   * 换片方向键与播放暂停热键。
   *
   * 抽屉打开时全部让路：评论列表与详情都是滚动容器，方向键和空格是它们的翻页。
   * `blocked` 因此是这一整段的前置条件，而不是逐个键判断。
   *
   * 上下键必须在**捕获阶段**抢先认领：进度条用的是 Video.js `TimeSlider`，它把
   * ↑/↓/PageUp/PageDown 也当 seek，而它的可聚焦元素是进度条里的 Thumb —— 用户碰过
   * 进度条后焦点就留在那里，冒泡阶段的监听（下面那个）已经先被它处理过了。捕获阶段
   * 先一步认领这四个键并阻止事件下传；←/→ 继续放行给进度条做 ±5s。
   */
  useEffect(() => {
    function onKeyDownCapture(event: KeyboardEvent) {
      if (event.defaultPrevented || blocked) return;
      const target = event.target;
      // 输入态（弹幕输入框等）、按钮与浮层不劫持这些键。
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, button, [contenteditable="true"], [data-slot="drawer-content"]',
        )
      ) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        event.stopPropagation();
        goToIndex(index + 1);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        event.stopPropagation();
        goToIndex(index - 1);
      }
    }
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [goToIndex, index, blocked]);

  /**
   * 播放暂停热键。
   *
   * 与换片方向键分开成两个监听：暂停键属于冒泡阶段（没有被原语抢），而方向键必须
   * 在捕获阶段先于进度条认领。
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || blocked) return;
      const target = event.target;
      // 输入态（弹幕输入框等）、按钮与浮层不劫持这些键。
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, button, [contenteditable="true"], [data-slot="drawer-content"], [data-slot="shorts-seek"]',
        )
      ) {
        return;
      }
      if (event.key === " " || event.key === "k" || event.key === "K") {
        event.preventDefault();
        playback.togglePlay();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [blocked, playback]);

  /** 切换页内模式前释放倍速与手势，不改动页面持有的槽位和下标。 */
  const resetInteraction = useCallback(() => {
    releaseSpeedHold();
    swipeRef.current = null;
    cancelSettle();
    setGestureActive(false);
    onMotionActiveChange(false);
  }, [cancelSettle, onMotionActiveChange, releaseSpeedHold]);

  return {
    gestureActive,
    onSurfaceTap,
    goToIndex,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onWheel,
    resetInteraction,
  };
}
