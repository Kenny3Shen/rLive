/**
 * Web Animations 的一次性补间助手，取代此前由 GSAP 承担的三个语义：
 *
 * 1. `overwrite: "auto"` —— 同一元素上开始新补间前先取消旧补间，
 *    快速点击、导航连打与手势切换不会叠加动画；
 * 2. `clearProps` —— 补间自然结束后撤销动画并归还行内动效样式
 *    （`settleTween`），元素不残留永久 transformed 祖先；
 * 3. `killTweensOf` —— 手动终止在飞补间。
 *
 * 运行中的 Animation 记录在以元素为键的 WeakMap 里，元素随子树卸载后
 * 条目被一并回收；被替换的补间立即 cancel，`finished` 的拒绝在这里吸收，
 * 调用方无需为取消路径各写一份 catch。
 */

const activeTweens = new WeakMap<Element, Animation>();

/** 开始一条补间，同元素上的旧补间先被取消。 */
export function tween(
  element: Element,
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  options?: number | KeyframeAnimationOptions,
): Animation {
  killTweensOf(element);
  const animation = element.animate(
    keyframes,
    typeof options === "number" ? { duration: options } : (options ?? {}),
  );
  activeTweens.set(element, animation);
  void animation.finished
    .catch(() => {})
    .finally(() => {
      if (activeTweens.get(element) === animation) {
        activeTweens.delete(element);
      }
    });
  return animation;
}

/** 取消元素上仍在运行的补间（GSAP `killTweensOf` 的等价物）。 */
export function killTweensOf(element: Element): void {
  activeTweens.get(element)?.cancel();
  activeTweens.delete(element);
}

const MOTION_INLINE_PROPERTIES = [
  "transform",
  "transform-origin",
  "opacity",
  "visibility",
  "will-change",
] as const;

/**
 * 清除补间留下的行内动效样式（GSAP `clearProps` 的等价物）。
 * 只应在结束帧与样式表自然态一致时调用；结束态需要保留的表面
 * 应继续持有 fill 动画或显式行内值。
 */
export function clearMotionStyles(element: HTMLElement | SVGElement): void {
  for (const property of MOTION_INLINE_PROPERTIES) {
    element.style.removeProperty(property);
  }
}

/**
 * 等补间自然结束后撤销它并归还行内样式。
 * 要求结束帧与元素的自然样式一致；补间被替换或取消时静默放弃。
 */
export function settleTween(element: HTMLElement | SVGElement, animation: Animation): void {
  void animation.finished
    .then(() => {
      animation.cancel();
      clearMotionStyles(element);
    })
    .catch(() => {});
}

/**
 * 等补间自然结束后把结束帧固化为行内样式再撤销动画。
 *
 * 与 `settleTween` 相对：结束帧需要保留的表面用它替代「fill 持有」。
 * fill 动画自然结束后不可再被 `killTweensOf` 找到（WeakMap 已忘记它），
 * 而部分 WebView 会把这种「已完成仍在填充」的动画从 `getAnimations()`
 * 里移除、其效果却继续挂在级联上——之后任何 cancel 都不会清掉它，
 * 元素会永久停留在旧效果上（音量/亮度提示卡在播放器中间不消失的根因）。
 * `commitStyles()` 把终态写进内联样式，cancel 后由内联值确定地持有结束帧；
 * 缺少 commitStyles 的旧 WebView 保留 fill 动画兜底。
 */
export function commitTween(animation: Animation): void {
  void animation.finished
    .then(() => {
      try {
        animation.commitStyles();
      } catch {
        return;
      }
      animation.cancel();
    })
    .catch(() => {});
}
