/**
 * 播放器 chrome 与房间表面所用毛玻璃材质的唯一事实来源。
 *
 * 有两种材质，以 `@utility` 类定义在 `src/styles.css`：
 * - `glass-surface` —— 应用上下文。由 `--popover` 调色，模糊更重。
 * - `glass-surface-overlay` —— 视频之上。填充更深、模糊刻意更轻，
 * 因为每一帧解码都会改变背景。
 *
 * 调用方传入自己的上下文即可，
 * 而不必在每个 popover 和抽屉处重新推导类组合加边框/文字/阴影修饰。
 */

/** 表面悬浮于视频之上、需要更深材质时为 true。 */
export type GlassSurfaceContext = { overlay?: boolean };

/**
 * 玻璃面板的材质类。
 *
 * `PopoverContent`/`DrawerContent`/`SelectContent` 上的 `glass` 属性只去掉不透明
 * 的 `bg-popover` 默认背景；材质本身来自这里，因此两者必须一起设置。
 */
export function glassSurfaceClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "glass-surface-overlay" : "glass-surface";
}

/**
 * 随视频之上材质附带的修饰：细边框、白色文字和更深的阴影。应用上下文中为空
 * —— 共享 popover/drawer token 相对 `--popover` 本来就正确。
 */
export function glassSurfaceTrimClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "border border-white/10 text-white shadow-xl" : "";
}

/** 材质加修饰，想让面板一次性拿到整套处理的场合使用。 */
export function glassPanelClass(context: GlassSurfaceContext = {}): string {
  const trim = glassSurfaceTrimClass(context);
  const material = glassSurfaceClass(context);
  return trim ? `${material} ${trim}` : material;
}

/**
 * 视频之上玻璃面板内的交互行。选中态用显式填充承载而不是 `secondary` 按钮
 * 变体 —— 后者的不透明 token 会在材质上凿出一个洞。
 */
export function glassOptionClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay
    ? "text-white hover:bg-white/12 hover:text-white data-highlighted:bg-white/12 data-highlighted:text-white data-selected:bg-white/18 data-selected:text-white data-selected:hover:bg-white/18 data-selected:data-highlighted:bg-white/18"
    : "";
}

/** 视频之上玻璃面板中某一行的选中填充。 */
export function glassOptionSelectedClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "bg-white/18 text-white" : "";
}

/** 分隔线与弱化标签需要在更深的叠加填充上提亮。 */
export function glassSeparatorClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "bg-white/10" : "";
}

export function glassMutedTextClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "text-white/60" : "";
}

/**
 * 玻璃 popover/抽屉中的分组标题（播放设置、字幕设置、定时关闭…）。
 * 紧凑的主标题 —— 保持播放器 chrome 标题一致。
 */
export function glassTitleClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "text-sm font-semibold text-white" : "text-sm font-semibold text-foreground";
}
