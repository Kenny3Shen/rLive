/**
 * 在整个进入全屏的过渡期间钉住应用外壳的安全区内边距。
 *
 * Android 上进入全屏会沉浸式隐藏系统栏，横屏方向锁也可能改变状态栏 inset。
 * Chromium 通过 `env(safe-area-inset-top)` 上报每个中间值，
 * `.app-shell` 把它消费为 `padding-top`。
 *
 * 两种全屏实现都需要这次保持，原因相同、方向相反：
 *
 * - 页面内固定层（Android Tauri，见 `androidImmersive`）在模式变化的同一帧把舞台
 * 移出文档流，画面无法移动 —— 但仍在其后的房间 chrome 会随每个中间 inset 重排，
 * 直到稳定前都会在固定层边缘周围显露。
 * - 浏览器 Fullscreen API（移动 Web）只有在请求 resolve 后才应用 `:fullscreen`，
 * 在此之前房间按常规布局，每个中间 inset 都会重排它：顶栏和固定比例的视频上滑、
 * `flex-1` 弹幕面板吸收腾出的高度。这就是最初报告的 bug —— 聊天在画面最终铺满
 * 屏幕前高出几帧。
 *
 * 把内边距冻结在手势开始时的取值上使舞台背后的页面静止，
 * inset 动画不再让它回流。
 */
export const FULLSCREEN_TRANSITION_ATTRIBUTE = "data-fullscreen-transition";

/** CSS 规则把 `.app-shell` 的 `padding-top` 钉到的自定义属性。 */
export const FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY = "--fullscreen-transition-safe-area-top";

/**
 * 冻结的时间上限，以防 fullscreenchange 永远不来。
 *
 * 被拒绝的请求本就会同步释放；这只覆盖 resolve 了 `requestFullscreen()`
 * 却从不触发事件的 WebView。足够长以挺过系统栏动画，
 * 又足够短使卡住的冻结无法比设置它的那次交互活得更久。
 */
export const FULLSCREEN_TRANSITION_TIMEOUT_MS = 1_200;

/** 本模块触碰的 `HTMLElement` 子集，保持可测试性。 */
export type FullscreenTransitionRoot = {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

/**
 * 只有 inset 驱动的移动外壳会在过渡中途回流。
 *
 * 桌面 Tauri 切换为原生窗口全屏且不带安全区内边距，在那里冻结什么也钉不住，
 * 还会无谓地忽略无关的 inset 变化。
 */
export function shouldFreezeFullscreenInsets(platform: string): boolean {
  return platform !== "desktop";
}

/**
 * 把计算出的 `padding-top` 归一化为值得钉住的取值。
 *
 * 为零或不可读的 inset 没有东西可以保持不动；报告为 `null` 让调用方完全跳过
 * 冻结，而不是安装一个不改变任何布局的覆盖值。
 */
export function frozenSafeAreaTopValue(paddingTop: string | null | undefined): string | null {
  if (!paddingTop) return null;
  const value = paddingTop.trim();
  if (!value) return null;
  const pixels = Number.parseFloat(value);
  if (!Number.isFinite(pixels) || pixels <= 0) return null;
  return value;
}

/**
 * 冻结外壳内边距并返回配套的释放函数。
 *
 * 释放是幂等的，因此 `fullscreenchange`、被拒绝的请求或超时谁先到谁结束冻结，
 * 其余都是无操作。调用方持有一份释放并在开启下一次过渡前调用，
 * 使过期的释放绝不可能清掉更新的冻结。
 */
export function beginFullscreenTransition(
  root: FullscreenTransitionRoot | null | undefined,
  frozenPaddingTop: string | null,
): () => void {
  if (!root || !frozenPaddingTop) return () => {};
  root.style.setProperty(FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY, frozenPaddingTop);
  root.setAttribute(FULLSCREEN_TRANSITION_ATTRIBUTE, "true");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    root.removeAttribute(FULLSCREEN_TRANSITION_ATTRIBUTE);
    root.style.removeProperty(FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY);
  };
}
