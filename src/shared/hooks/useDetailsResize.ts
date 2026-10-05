import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import {
  clampDetailsSharePercent,
  detailsResizeCeiling,
  detailsResizeIntent,
  detailsResizeSharePercent,
  detailsShareCssValue,
  detailsShareFromHeights,
  detailsShareMaxPercent,
} from "@/shared/gestures/detailsResize";
import { isTouchLikePointer } from "@/shared/gestures/playerEdgeGesture";

type ResizeState = {
  pointerId: number;
  target: HTMLElement;
  startX: number;
  startY: number;
  startPercent: number;
  containerHeight: number;
  /** 本次手势的上限（%），按下时按容器宽度算定：舞台必须保住一个全宽 16:9。 */
  maxPercent: number;
  intent: "pending" | "resize" | "swipe";
  /** 手指按下后是否已越过锁定距离并真正开始拖动。 */
  active: boolean;
  /** 最近一次请求的占比（%），下一预览帧或取消时沿用它。 */
  lastPercent: number;
};

export type UseDetailsResizeOptions = {
  /** 手势总闸（仅移动端）。 */
  enabled: boolean;
  /** 播放页主区域（舞台 + 详情区），占比相对它计算。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 详情侧栏，未拖动过时按它的实际高度起算。 */
  detailsRef: RefObject<HTMLElement | null>;
  /** 拖动中的占比（%）。逐帧写 CSS 变量，不进 React 状态。 */
  onPreview: (percent: number) => void;
  /** 松手提交；宿主据此更新状态（本页内保留，不落盘）。 */
  onCommit: (percent: number) => void;
  /**
   * 容器尺寸变化后，已提交的占比超出新上限时回调收后的取值（%） ——
   * 旋转、分屏、浏览器栏伸缩都算。不传则不做这件事。
   */
  onClamp?: (percent: number) => void;
};

/**
 * 移动端 VOD 详情侧栏的占比拖动。
 *
 * 与页签条自己的 `useHorizontalSwipe` 共存：两者都在捕获阶段拿同一串指针事件，
 * 但锁轴判定互斥 —— 本 hook 只在纵向锁定后 `setPointerCapture` 并
 * `preventDefault`，横向拖动因此原样落到 swipe 上（反之本 hook 直接放手）。
 *
 * 拖动期间只写 CSS 变量与自定义属性，不触发 React 渲染：侧栏里挂着评论列表、
 * 弹幕列表，舞台里还有播放器，逐帧重渲染会被明确感知到。
 */
export function useDetailsResize({
  enabled,
  containerRef,
  detailsRef,
  onPreview,
  onCommit,
  onClamp,
}: UseDetailsResizeOptions) {
  const stateRef = useRef<ResizeState | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const callbacksRef = useRef({ onPreview, onCommit });
  const clampRef = useRef(onClamp);
  // 渲染期不写 ref：提交后同步 latest 值，读者全部在事件与效果里，时序等价。
  useLayoutEffect(() => {
    callbacksRef.current = { onPreview, onCommit };
    clampRef.current = onClamp;
  });

  const cancelPreview = useCallback(() => {
    if (previewFrameRef.current === null) return;
    window.cancelAnimationFrame(previewFrameRef.current);
    previewFrameRef.current = null;
  }, []);

  const releasePointer = useCallback((element: HTMLElement, pointerId: number) => {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }, []);

  /**
   * 按下瞬间的占比基准与上限。
   *
   * 占比量侧栏与容器的真实高度：舞台按画幅比撑高，未调整过时状态里没有值，
   * 必须按当前布局起算，否则第一次拖动会跳一下。
   *
   * 上限看容器宽度：舞台要保住一个满宽 16:9 视频窗口，因此容器越宽、能给侧栏
   * 的份额越少（401×757 的手机上约 70%）。自定义画幅比它高的默认布局上限就是
   * 起点，读作「只能往小拖」；两者都在按下那一刻定住，拖动中不重算 —— 拖动会
   * 改容器高度，重算上限会让边界跟着手指跑。
   */
  const gestureBounds = useCallback(() => {
    const container = containerRef.current;
    const details = detailsRef.current;
    if (!container || !details) return null;
    const containerHeight = container.clientHeight;
    const containerWidth = container.clientWidth;
    if (!(containerHeight > 0)) return null;
    const startPercent = detailsShareFromHeights(
      details.getBoundingClientRect().height,
      containerHeight,
    );
    return {
      containerHeight,
      startPercent,
      maxPercent: detailsResizeCeiling(startPercent, containerWidth, containerHeight),
    };
  }, [containerRef, detailsRef]);

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // 部分 Android WebView 对手指输入上报空的 pointerType。
      if (!enabled || !isTouchLikePointer(event.pointerType) || !event.isPrimary) return;
      if (stateRef.current !== null) return;
      const bounds = gestureBounds();
      if (!bounds) return;
      stateRef.current = {
        pointerId: event.pointerId,
        target: event.currentTarget,
        startX: event.clientX,
        startY: event.clientY,
        startPercent: bounds.startPercent,
        containerHeight: bounds.containerHeight,
        maxPercent: bounds.maxPercent,
        intent: "pending",
        active: false,
        lastPercent: bounds.startPercent,
      };
    },
    [enabled, gestureBounds],
  );

  /** 返回 true 表示本次指针已被调占比认领，页签条不应再处理它。 */
  const onPointerMoveCapture = useCallback((event: ReactPointerEvent<HTMLElement>): boolean => {
    const state = stateRef.current;
    if (!state || state.pointerId !== event.pointerId) return false;

    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;

    if (!state.active) {
      if (state.intent === "pending") {
        state.intent = detailsResizeIntent(deltaX, deltaY);
      }
      // 横向锁定：本次手势归页签条的翻页，本 hook 彻底放手。
      if (state.intent === "swipe") {
        stateRef.current = null;
        return false;
      }
      if (state.intent === "pending") return true;
      state.active = true;
      // 锁定后才捕获：短触摸必须保持原始目标，页签的合成 click 才能照常派发。
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    const preview = detailsResizeSharePercent(
      state.startPercent,
      deltaY,
      state.containerHeight,
      state.maxPercent,
    );
    state.lastPercent = preview;
    // 调占比会触发布局（不同于横滑只写 transform），一帧内的高频事件合并，
    // 只应用最新位置。释放/取消时撤掉待执行帧，不能让旧预览覆盖最终提交。
    if (previewFrameRef.current === null) {
      previewFrameRef.current = window.requestAnimationFrame(() => {
        previewFrameRef.current = null;
        if (stateRef.current === state) callbacksRef.current.onPreview(state.lastPercent);
      });
    }
    event.preventDefault();
    return true;
  }, []);

  /** 返回 true 表示松手前是调占比手势（页签条不应据此翻页）。 */
  const onPointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const state = stateRef.current;
      if (!state || state.pointerId !== event.pointerId) return false;
      stateRef.current = null;
      cancelPreview();
      releasePointer(event.currentTarget, event.pointerId);
      if (!state.active) return false;

      // 提交与预览用同一套换算，且同一上限 —— 预览已经夹在范围内，两者一致。
      const committed = clampDetailsSharePercent(
        detailsResizeSharePercent(
          state.startPercent,
          event.clientY - state.startY,
          state.containerHeight,
          state.maxPercent,
        ),
        state.maxPercent,
      );
      state.lastPercent = committed;
      callbacksRef.current.onCommit(committed);
      event.preventDefault();
      return true;
    },
    [cancelPreview, releasePointer],
  );

  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      stateRef.current = null;
      cancelPreview();
      releasePointer(event.currentTarget, event.pointerId);
      // 取消不回到按下前的值：用户已经看到拖动结果，回跳比停在当前值更突兀。
      // 只有「从未真正拖动过」（按下就被取消）才保留原状。
      if (state.active) {
        callbacksRef.current.onCommit(
          clampDetailsSharePercent(state.lastPercent, state.maxPercent),
        );
      }
    },
    [cancelPreview, releasePointer],
  );

  const clearGesture = useCallback(() => {
    cancelPreview();
    const state = stateRef.current;
    stateRef.current = null;
    if (state) releasePointer(state.target, state.pointerId);
    return state;
  }, [cancelPreview, releasePointer]);

  // 全屏/宽屏停用手势时提交最后的位置并释放捕获；卸载只清理，不再更新宿主状态。
  useLayoutEffect(() => {
    if (enabled) return;
    const state = clearGesture();
    if (state?.active) callbacksRef.current.onCommit(state.lastPercent);
    clearDetailsResizing(containerRef.current);
  }, [clearGesture, containerRef, enabled]);
  useLayoutEffect(
    () => () => {
      clearGesture();
    },
    [clearGesture],
  );

  /**
   * 容器尺寸一变（旋转、分屏、浏览器栏伸缩）就重算上限：已提交的占比若超出新上限，
   * 收回去。否则竖屏里调大的侧栏会在容器变矮后把画面压到 16:9 窗口以下，不再满足
   * 这条手势的承诺。
   *
   * 当前值从内联自定义属性读，不从 props 走：它就是「是否已拖动过」的唯一事实源，
   * 未拖动过时为空字符串（此时舞台按画幅比分配，不归手势管）。
   * 拖动中不插手，那时上限由手势自己的快照决定（且拖动不改容器高度，不会互相触发）。
   */
  useLayoutEffect(() => {
    if (!enabled || !onClamp) return;
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      if (stateRef.current !== null) return;
      const current = Number.parseFloat(container.style.getPropertyValue("--vod-details-share"));
      if (!Number.isFinite(current)) return;
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!(width > 0) || !(height > 0)) return;
      const clamped = clampDetailsSharePercent(current, detailsShareMaxPercent(width, height));
      if (Math.abs(clamped - current) > 0.01) clampRef.current?.(clamped);
    };
    const observer = new ResizeObserver(apply);
    observer.observe(container);
    apply();
    return () => observer.disconnect();
  }, [containerRef, enabled, onClamp]);

  if (!enabled) {
    return {
      onPointerDownCapture: undefined,
      onPointerMoveCapture: undefined,
      onPointerUpCapture: undefined,
      onPointerCancelCapture: undefined,
    };
  }

  return {
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
  };
}

/**
 * 把占比写到播放页主区域的 CSS 变量上，并标出「正在拖动」。
 *
 * 舞台与侧栏的分配全部由布局自己按 `--vod-details-share` 算，JS 只写这一个值：
 * 拖动每一帧因此只碰一个自定义属性，不触发 React 渲染，也不逐个元素改样式。
 *
 * 这里写的两个属性都不能交给 React 渲染：播放中的 `timeupdate` 每秒触发多次
 * `setCurrentTime`，每次提交都会把 React 没渲染过的属性当垃圾清掉，属性一消失
 * 舞台就跳回画幅比高度（实测表现为拖动中画面一跳一跳）。
 *
 * 因此两个属性各司其职，且**只有本函数写 `-resizing`**：
 *
 * - `data-vod-details-resizing`：仅拖动中存在，松手由 `clearDetailsResizing` 撤掉；
 * - `--vod-details-share`：拖动的实时取值，提交后由 React 接管（内联样式）。
 *
 * 提交后「已经拖过一次」这个状态由 React 渲染的 `data-vod-details-share` 表达，
 * 两个属性在样式表里是同一个条件的两条选择器，见 `styles.css`。
 */
export function writeDetailsShare(container: HTMLElement | null, percent: number): void {
  if (!container) return;
  // 取值已在手势里夹到动态上限（≤ 硬顶），这里只负责格式化。
  const value = detailsShareCssValue(percent);
  if (container.style.getPropertyValue("--vod-details-share") !== value) {
    container.style.setProperty("--vod-details-share", value);
  }
  if (container.dataset.vodDetailsResizing !== "true") {
    container.dataset.vodDetailsResizing = "true";
  }
}

/** 拖动结束：保留最终占比，只撤掉「正在拖动」标记。 */
export function clearDetailsResizing(container: HTMLElement | null): void {
  if (!container) return;
  delete container.dataset.vodDetailsResizing;
}
