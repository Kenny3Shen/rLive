/**
 * Video.js 弹层的共用表面类。
 *
 * `Popover.Popup`／`Menu.Popup` 这类元素带 `popover` 属性，会进入 top layer，并按
 * UA 样式表绘制 `border: solid`、`padding: 0.25em` 和不透明的 `Canvas` 背景。前两项
 * 会给面板镶一圈硬边，最后一项对毛玻璃是致命的：`backdrop-filter` 采样的是元素下方的
 * 内容，而那块实心 `Canvas` 正好顶在中间 —— 面板于是退化成一块实色矩形，看起来
 * 「没有毛玻璃效果」。
 *
 * 所以弹层元素必须显式重置这三项：材质直接画在弹层上的（`mediaPopupSurfaceClass`）
 * 顺手覆盖掉背景，材质画在子元素上的（控制栏的玻璃菜单）则要自己补 `bg-transparent`。
 *
 * `position`、`inset` 与 `margin` 已由 `usePopupPosition` 以内联样式接管，这里不重复。
 */

/** UA `[popover]` 外观重置。`m-0` 与定位层写入的内联值一致，保留以便单独使用。 */
export const mediaPopupResetClass = "m-0 overflow-visible border-0 text-inherit";

/**
 * 开合过渡：按 `data-side` 决定缩放原点与位移方向，并用 `::before` 在弹层与触发器
 * 之间的间隙上铺一层可命中的桥接区，指针横穿间隙时不会触发收起。
 *
 * 桥接区长度取自 `--media-popup-side-offset`，调用方须把它指向自己命名空间的偏移
 * 变量（弹层是 `--media-popover-side-offset`，tooltip 是 `--media-tooltip-side-offset`）。
 *
 * 这段样式占用了 `::before`，因此玻璃材质的 `::before` 填充不能和它挂同一个元素。
 */
export const mediaPopupMotionClass = [
  "media-transitioning:opacity-0 media-transitioning:blur-media-hidden-popup media-transitioning:scale-media-hidden-popup",
  "data-starting-style:[transform:translate(var(--media-popup-translate-x-distance,0),var(--media-popup-translate-y-distance,0))]",
  "data-ending-style:transform-none",
  "data-[side=top]:origin-bottom data-[side=bottom]:origin-top data-[side=left]:origin-right data-[side=right]:origin-left",
  "data-[side=top]:[--media-popup-translate-y-distance:var(--media-popup-translate-distance)]",
  "data-[side=bottom]:[--media-popup-translate-y-distance:calc(var(--media-popup-translate-distance)*-1)]",
  "data-[side=left]:[--media-popup-translate-x-distance:var(--media-popup-translate-distance)]",
  "data-[side=right]:[--media-popup-translate-x-distance:calc(var(--media-popup-translate-distance)*-1)]",
  "before:pointer-events-auto before:absolute",
  "data-[side=top]:before:inset-x-0 data-[side=top]:before:top-full",
  "data-[side=bottom]:before:inset-x-0 data-[side=bottom]:before:bottom-full",
  "data-[side=left]:before:inset-y-0 data-[side=left]:before:left-full",
  "data-[side=right]:before:inset-y-0 data-[side=right]:before:right-full",
  "data-[side=top]:before:h-(--media-popup-side-offset) data-[side=bottom]:before:h-(--media-popup-side-offset)",
  "data-[side=left]:before:w-(--media-popup-side-offset) data-[side=right]:before:w-(--media-popup-side-offset)",
  "transition-media-popup data-ending-style:duration-media-instant",
].join(" ");

/**
 * Video.js 自带材质：音量、tooltip、进度缩略图与错误对话框。
 *
 * 环形描边走 `::after`，因此可以和上面的指针桥接区共存于同一个元素。
 */
export const mediaPopupSurfaceClass =
  "bg-media-popover text-media-popover-foreground surface-media after:surface-media-inset";
