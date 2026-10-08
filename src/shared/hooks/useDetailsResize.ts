import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import {
  clampDetailsSharePercent,
  detailsContentScrollStep,
  detailsResizeCeiling,
  detailsResizeIntent,
  detailsShareCssValue,
  detailsShareFromHeights,
  detailsShareMaxPercent,
  detailsShareMinPercent,
} from "@/shared/gestures/detailsResize";

type ResizeState = {
  touchId: number;
  startX: number;
  startY: number;
  lastY: number;
  containerWidth: number;
  containerHeight: number;
  aspectRatio: number | null;
  minPercent: number;
  maxPercent: number;
  intent: "pending" | "resize" | "swipe";
  active: boolean;
  lastPercent: number;
  scrollers: HTMLElement[];
};

export type UseDetailsResizeOptions = {
  /** 仅移动端、上下布局、已知非 16:9 视频且不在全屏时启用。 */
  enabled: boolean;
  /** 原始源画幅，用于恢复默认舞台（满宽按比值撑高，最高占容器 70%）。 */
  aspectRatio?: number | null;
  containerRef: RefObject<HTMLElement | null>;
  detailsRef: RefObject<HTMLElement | null>;
  /** 逐帧预览不进入 React 状态；结束后由宿主提交。 */
  onPreview: (percent: number) => void;
  onCommit: (percent: number) => void;
  onClamp?: (percent: number) => void;
};

/** 只收集命中内容到页签视口内的滚动链，不滚动页面或后台页签。 */
function contentScrollers(target: Element, viewport: HTMLElement): HTMLElement[] {
  const scrollers: HTMLElement[] = [];
  for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
    if (
      node instanceof HTMLElement &&
      /^(auto|scroll)$/.test(getComputedStyle(node).overflowY) &&
      node.scrollHeight > node.clientHeight
    ) {
      scrollers.push(node);
    }
  }
  return scrollers;
}

function scrollContent(scrollers: HTMLElement[], delta: number): void {
  for (const node of scrollers) {
    const before = node.scrollTop;
    node.scrollTop += delta;
    delta -= node.scrollTop - before;
    if (Math.abs(delta) < 0.5) break;
  }
}

/**
 * 移动端内容滑动自适应侧栏。返回值只绑定页签内容视口，Tab 栏不参与。
 *
 * touchmove 使用原生非 passive 监听器：纵向原生滚动会取消 PointerEvent，
 * React 的 passive touchmove 又无法阻止同一位移被浏览器和布局各消费一次。
 * 仅需改变占比时认领手势；到达边界的剩余位移交给命中的滚动链。完全不需调整
 * 时保留原生滚动及惯性，已由浏览器认领的不可取消事件不再抢回。
 */
export function useDetailsResize({
  enabled,
  aspectRatio = null,
  containerRef,
  detailsRef,
  onPreview,
  onCommit,
  onClamp,
}: UseDetailsResizeOptions) {
  const stateRef = useRef<ResizeState | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  const callbacksRef = useRef({ onPreview, onCommit, onClamp });
  const aspectRatioRef = useRef(aspectRatio);
  useLayoutEffect(() => {
    callbacksRef.current = { onPreview, onCommit, onClamp };
    aspectRatioRef.current = aspectRatio;
  });

  const cancelPreview = useCallback(() => {
    if (previewFrameRef.current === null) return;
    window.cancelAnimationFrame(previewFrameRef.current);
    previewFrameRef.current = null;
  }, []);

  const finish = useCallback(() => {
    const state = stateRef.current;
    stateRef.current = null;
    cancelPreview();
    if (state?.active) {
      callbacksRef.current.onCommit(state.lastPercent);
      suppressClickUntilRef.current = Date.now() + 420;
    }
  }, [cancelPreview]);

  const bindContent = useCallback(
    (viewport: HTMLDivElement | null) => {
      if (!viewport || !enabled) return;
      const start = (event: TouchEvent) => {
        if (event.touches.length !== 1) {
          finish();
          return;
        }
        const target = event.target;
        if (!(target instanceof Element) || !viewport.contains(target)) return;
        if (
          target.closest(
            'input, textarea, select, [contenteditable="true"], [role="slider"], [role="switch"], [role="dialog"], [data-slot="scroll-area-scrollbar"]',
          )
        )
          return;
        const container = containerRef.current;
        const details = detailsRef.current;
        if (!container || !details || container.clientHeight <= 0) return;
        const touch = event.touches[0];
        const percent = detailsShareFromHeights(
          details.getBoundingClientRect().height,
          container.clientHeight,
        );
        const minPercent = detailsShareMinPercent(
          container.clientWidth,
          container.clientHeight,
          aspectRatioRef.current,
        );
        stateRef.current = {
          touchId: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          lastY: touch.clientY,
          containerWidth: container.clientWidth,
          containerHeight: container.clientHeight,
          aspectRatio: aspectRatioRef.current,
          minPercent,
          maxPercent: detailsResizeCeiling(
            percent,
            container.clientWidth,
            container.clientHeight,
            minPercent,
          ),
          intent: "pending",
          active: false,
          lastPercent: percent,
          scrollers: contentScrollers(target, viewport),
        };
      };
      const move = (event: TouchEvent) => {
        const state = stateRef.current;
        if (!state) return;
        if (event.touches.length !== 1) {
          finish();
          return;
        }
        const touch = Array.from(event.touches).find((item) => item.identifier === state.touchId);
        if (!touch) return;
        if (state.intent === "pending") {
          state.intent = detailsResizeIntent(
            touch.clientX - state.startX,
            touch.clientY - state.startY,
          );
        }
        if (state.intent === "swipe") {
          stateRef.current = null;
          return;
        }
        if (state.intent === "pending") return;
        const delta = touch.clientY - state.lastY;
        state.lastY = touch.clientY;
        // 原生滚动已开始后不能再改布局，否则同一手指位移会被消费两次。
        if (!event.cancelable) return;
        const next = detailsContentScrollStep(
          state.lastPercent,
          delta,
          state.scrollers.reduce((sum, node) => sum + Math.max(0, node.scrollTop), 0),
          state.containerHeight,
          state.maxPercent,
          state.minPercent,
        );
        const changed = Math.abs(next.percent - state.lastPercent) > 0.0001;
        if (!state.active && !changed) return;
        event.preventDefault();
        state.active = true;
        state.lastPercent = next.percent;
        if (changed && previewFrameRef.current === null) {
          previewFrameRef.current = window.requestAnimationFrame(() => {
            previewFrameRef.current = null;
            if (stateRef.current === state) callbacksRef.current.onPreview(state.lastPercent);
          });
        }
        scrollContent(state.scrollers, next.scrollDelta);
      };
      const end = (event: TouchEvent) => {
        const state = stateRef.current;
        if (
          state &&
          Array.from(event.changedTouches).some((item) => item.identifier === state.touchId)
        ) {
          finish();
        }
      };
      const click = (event: MouseEvent) => {
        if (Date.now() >= suppressClickUntilRef.current) return;
        event.preventDefault();
        event.stopPropagation();
      };
      viewport.addEventListener("touchstart", start, { passive: true, capture: true });
      viewport.addEventListener("touchmove", move, { passive: false, capture: true });
      viewport.addEventListener("touchend", end, true);
      viewport.addEventListener("touchcancel", end, true);
      viewport.addEventListener("click", click, true);
      // React 19 回调 ref 清理：移除监听器并丢弃未提交帧，卸载不更新宿主状态。
      return () => {
        viewport.removeEventListener("touchstart", start, true);
        viewport.removeEventListener("touchmove", move, true);
        viewport.removeEventListener("touchend", end, true);
        viewport.removeEventListener("touchcancel", end, true);
        viewport.removeEventListener("click", click, true);
        cancelPreview();
        stateRef.current = null;
        clearDetailsResizing(containerRef.current);
      };
    },
    [cancelPreview, containerRef, detailsRef, enabled, finish],
  );

  useLayoutEffect(() => {
    if (!enabled) clearDetailsResizing(containerRef.current);
  }, [containerRef, enabled]);

  // 旋转/分屏/画幅变化后重算双向边界；未调整过的默认布局不参与。
  useLayoutEffect(() => {
    if (!enabled || !onClamp) return;
    const container = containerRef.current;
    if (!container) return;
    const apply = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!(width > 0) || !(height > 0)) return;
      const state = stateRef.current;
      if (state) {
        if (
          state.containerWidth === width &&
          state.containerHeight === height &&
          Object.is(state.aspectRatio, aspectRatio)
        ) {
          return;
        }
        // 几何变化让本次位移尺度失效：先提交并结束，再按新边界收口，不能等下次手势。
        finish();
      }
      const current = state?.active
        ? state.lastPercent
        : Number.parseFloat(container.style.getPropertyValue("--vod-details-share"));
      if (!Number.isFinite(current)) return;
      const minPercent = detailsShareMinPercent(width, height, aspectRatio);
      const clamped = clampDetailsSharePercent(
        current,
        detailsShareMaxPercent(width, height),
        minPercent,
      );
      if (Math.abs(clamped - current) > 0.01) callbacksRef.current.onClamp?.(clamped);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(container);
    return () => observer.disconnect();
  }, [aspectRatio, containerRef, enabled, finish, onClamp]);

  return bindContent;
}

/** 高频变量不继承到内容子树；预览标记只由手势写，避免 React 播放进度提交干扰。 */
export function writeDetailsShare(container: HTMLElement | null, percent: number): void {
  if (!container) return;
  const value = detailsShareCssValue(percent);
  if (container.style.getPropertyValue("--vod-details-share") !== value) {
    container.style.setProperty("--vod-details-share", value);
  }
  if (container.dataset.vodDetailsResizing !== "true") {
    container.dataset.vodDetailsResizing = "true";
  }
}

/** 结束预览：保留最终占比，只撤掉实时调整标记。 */
export function clearDetailsResizing(container: HTMLElement | null): void {
  if (!container) return;
  delete container.dataset.vodDetailsResizing;
}
