import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import {
  clampDetailsSharePercent,
  detailsResizeIntent,
  detailsResizeSharePercent,
  detailsShareCssValue,
  detailsShareFromHeights,
} from "@/shared/gestures/detailsResize";
import { isTouchLikePointer } from "@/shared/gestures/playerEdgeGesture";

type ResizeState = {
  pointerId: number;
  startX: number;
  startY: number;
  startPercent: number;
  containerHeight: number;
  intent: "pending" | "resize" | "swipe";
  /** 手指按下后是否已越过锁定距离并真正开始拖动。 */
  active: boolean;
  /** 最近一次写出去的占比（%），取消时沿用它。 */
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
}: UseDetailsResizeOptions) {
  const stateRef = useRef<ResizeState | null>(null);
  const callbacksRef = useRef({ onPreview, onCommit });
  // 渲染期不写 ref：提交后同步 latest 值，读者全部在事件与效果里，时序等价。
  useLayoutEffect(() => {
    callbacksRef.current = { onPreview, onCommit };
  });

  const releasePointer = useCallback((element: HTMLElement, pointerId: number) => {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }, []);

  /**
   * 按下瞬间的占比基准。
   *
   * 已经调过占比时量 CSS 变量，否则量侧栏与容器的真实高度 —— 舞台按画幅比撑高，
   * 未调整过时状态里没有值，必须按当前布局起算，否则第一次拖动会跳一下。
   */
  const startPercent = useCallback(() => {
    const container = containerRef.current;
    const details = detailsRef.current;
    if (!container || !details) return null;
    const containerHeight = container.clientHeight;
    if (!(containerHeight > 0)) return null;
    return detailsShareFromHeights(details.getBoundingClientRect().height, containerHeight);
  }, [containerRef, detailsRef]);

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // 部分 Android WebView 对手指输入上报空的 pointerType。
      if (!enabled || !isTouchLikePointer(event.pointerType) || !event.isPrimary) return;
      if (stateRef.current !== null) return;
      const percent = startPercent();
      const containerHeight = containerRef.current?.clientHeight ?? 0;
      if (percent === null || !(containerHeight > 0)) return;
      stateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startPercent: percent,
        containerHeight,
        intent: "pending",
        active: false,
        lastPercent: percent,
      };
    },
    [containerRef, enabled, startPercent],
  );

  /** 返回 true 表示本次指针已被调占比认领，页签条不应再处理它。 */
  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
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

      const preview = detailsResizeSharePercent(state.startPercent, deltaY, state.containerHeight);
      state.lastPercent = preview;
      callbacksRef.current.onPreview(preview);
      event.preventDefault();
      return true;
    },
    [],
  );

  /** 返回 true 表示松手前是调占比手势（页签条不应据此翻页）。 */
  const onPointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const state = stateRef.current;
      if (!state || state.pointerId !== event.pointerId) return false;
      stateRef.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      if (!state.active) return false;

      // 提交与预览用同一套换算，但提交值必须收回范围内 —— 阻尼越界的部分不落定。
      const committed = clampDetailsSharePercent(
        detailsResizeSharePercent(
          state.startPercent,
          event.clientY - state.startY,
          state.containerHeight,
        ),
      );
      state.lastPercent = committed;
      callbacksRef.current.onCommit(committed);
      event.preventDefault();
      return true;
    },
    [releasePointer],
  );

  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      stateRef.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      // 取消不回到按下前的值：用户已经看到拖动结果，回跳比停在当前值更突兀。
      // 只有「从未真正拖动过」（按下就被取消）才保留原状。
      if (state.active) callbacksRef.current.onCommit(clampDetailsSharePercent(state.lastPercent));
    },
    [releasePointer],
  );

  // 手势期间组件卸载必须放掉状态，避免旧指针继续改新页面。
  useLayoutEffect(
    () => () => {
      stateRef.current = null;
    },
    [],
  );

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
  container.style.setProperty("--vod-details-share", detailsShareCssValue(percent));
  container.dataset.vodDetailsResizing = "true";
}

/** 拖动结束：保留最终占比，只撤掉「正在拖动」标记（高度过渡随之恢复）。 */
export function clearDetailsResizing(container: HTMLElement | null): void {
  if (!container) return;
  delete container.dataset.vodDetailsResizing;
}
