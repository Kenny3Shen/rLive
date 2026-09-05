import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { DragOverlay } from "@dnd-kit/core";

/**
 * 关注页两个视图共用的拖拽预览层。
 *
 * 它渲染进 `document.body`：`DragOverlay` 用 `position: fixed` 加视口坐标定位，
 * 而直播与 IPTV 关注都活在 `[data-slot="horizontal-swipe-track"]` 里，
 * 那条 track 连静止时都带着 `translate3d(...)`（页签位置本身就是 transform，
 * 见 `useHorizontalSwipe`），transform 会让它成为 fixed 后代的包含块，
 * 预览于是被整体平移到 track 的左上角，不再跟着指针。
 */
export function FollowDragOverlayPortal({ children }: { children: ReactNode }) {
  return createPortal(
    <DragOverlay dropAnimation={{ duration: 160, easing: "ease-out" }}>{children}</DragOverlay>,
    document.body,
  );
}
