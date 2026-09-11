import { useDoubleTapGesture, useTapGesture } from "@videojs/react";
import type { RefObject } from "react";

/**
 * 画面点按/双击：统一走 Video.js 官方手势识别器
 * （`useTapGesture` / `useDoubleTapGesture`，见「Add keyboard shortcuts and gestures」）。
 *
 * 为什么用钩子而不是声明式 `<Gesture action="…">`：声明式绑定解析为
 * `store.state[action]()`，而本项目的 chrome 显隐、三路径全屏（桌面 Tauri 原生窗口 /
 * Android 页内固定层 / HTML Fullscreen API）与 `userPausedRef` 暂停记账都不在
 * Video.js store 里 —— 原生动作会写没人读的状态，Android 还会踩回它刻意避开的
 * Fullscreen API。钩子形态只借用识别器，动作仍由各播放页自己执行。
 *
 * 借到的部分正是此前每页各写一遍的：pointerdown→pointerup 的 250ms 点按阈值、
 * 单击与双击共享的 200ms 判定窗口（有双击绑定时单击自动延后，没有时立即触发）、
 * `isInteractiveTarget` 跳过按钮与滑块、`isInteractionLocked` 尊重浮层独占。
 * 一个 target 上只有一个识别器实例，因此单击与双击必须挂在同一个 target 上。
 *
 * 识别器用原生监听挂在 target 上，早于 React 委托到根节点的 pointerup。因此长按
 * 倍速、边缘滑动、上下换片这些业务手势必须在**进行中**就置好抑制标志（它们都在
 * pointermove/长按触发时置位），而不是等到 pointerup 再置 —— `shouldIgnore`
 * 读到的就是那个标志。
 */
export type PlayerStageTapGesturesOptions = {
  /**
   * 手势宿主元素。单击与双击共用它，识别器按其宽度划分 region。
   * 不传则落到 Player 上下文的容器，本项目各播放页的舞台就是那个容器。
   */
  target?: RefObject<HTMLElement | null>;
  /** 总闸：锁定全屏、无画面、加载失败等场景下传 false。 */
  enabled?: boolean;
  /** 限定指针类型；不传则鼠标与触摸都响应。 */
  pointer?: "mouse" | "touch" | "pen";
  /** 单击动作。不传则不注册单击绑定，双击的 200ms 延后也随之消失。 */
  onTap?: ((event: PointerEvent) => void) | undefined;
  /** 双击动作。不传则单击立即触发，不再等待第二次点按。 */
  onDoubleTap?: ((event: PointerEvent) => void) | undefined;
  /**
   * 逐次否决。识别器只会过滤按钮/滑块这类通用交互目标，业务自己的抑制
   * （长按倍速、滑动换片、边缘调节、控制栏空白区）在这里判断。
   */
  shouldIgnore?: ((event: PointerEvent) => boolean) | undefined;
};

export function usePlayerStageTapGestures({
  target,
  enabled = true,
  pointer,
  onTap,
  onDoubleTap,
  shouldIgnore,
}: PlayerStageTapGesturesOptions): void {
  useTapGesture(
    (event) => {
      if (shouldIgnore?.(event)) return;
      onTap?.(event);
    },
    { target, pointer, disabled: !enabled || !onTap },
  );

  useDoubleTapGesture(
    (event) => {
      if (shouldIgnore?.(event)) return;
      onDoubleTap?.(event);
    },
    { target, pointer, disabled: !enabled || !onDoubleTap },
  );
}
