import type { DrawerSide } from "@/components/ui/drawer";

/**
 * 播放表面上「面板抽屉」的几何：侧别与尺寸。
 *
 * 一处定义是因为这类抽屉会**互相叠**：短视频的评论抽屉打开后，点某条评论的回复
 * 会在它上面再叠一层二级抽屉。两层的侧别与尺寸必须完全一致 —— 差一点就露出下面
 * 那层的边，看上去像两套面板。实际发生过：二级走基础组件的 `right` 默认宽
 * （20rem），而评论抽屉是 22rem，桌面上右侧露出一条 32px 的缝；手机上更明显 ——
 * 一级是底部抽屉，二级却从右侧滑进来一条窄条。
 *
 * 只描述侧别与尺寸。表头、滚动容器与安全区内边距不在这里：各调用方不同（评论体
 * 不自带滚动容器、二级回复自带），塞进来就得加一串开关。
 */

/** 与直播页侧栏同宽（`PlayerPane` 的 `w-[min(22rem,78vw)]`）。 */
const PANEL_DRAWER_WIDTH_CLASS = "w-[min(22rem,78vw)]";

/**
 * 紧凑视口从下方弹出，宽视口从右侧滑入。
 *
 * 竖屏上右侧抽屉只能占屏宽的一部分，评论正文被压成两三个字一行；而桌面上底部抽屉
 * 会把画面从下方顶掉一大块。侧别按视口决定，不按内容决定。
 *
 * `scoped` 一律走 `right`：那是「抽屉挂在侧栏的 `DrawerViewport` 里」（播放页），
 * 基础组件已经把它改成铺满容器的 `absolute`，侧别只剩推入方向的动画语义 —— 而侧栏
 * 里那一层本来就是从右边推进来的。
 */
export function panelDrawerSide(compact: boolean, scoped = false): DrawerSide {
  if (scoped) return "right";
  return compact ? "bottom" : "right";
}

/**
 * 面板抽屉的尺寸类名。
 *
 * `scoped` 时只给高度：基础组件已经写了 `absolute max-h-full w-full`，宽高由侧栏
 * 决定。这里再写死会把 `70dvh` 泄进侧栏 —— 抽屉只占侧栏上面七成，下面露出评论列表。
 */
export function panelDrawerSizeClass(side: DrawerSide, scoped = false): string {
  if (scoped) return "h-full";
  return side === "bottom"
    ? "h-[70dvh] max-h-[70dvh]"
    : `h-full ${PANEL_DRAWER_WIDTH_CLASS}`;
}
