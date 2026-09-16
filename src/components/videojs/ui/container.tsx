import "../styles/theme.css";
import { forwardRef, useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { Container as ContainerPrimitive } from "@videojs/react";

import { cn } from "@/components/videojs/lib/resolve-class-name";

export interface ContainerProps extends Omit<ContainerPrimitive.Props, "children"> {
  children?: ContainerPrimitive.Props["children"];
}

/** 可编辑的目标：焦点必须留在它身上，否则用户敲的字会落空。 */
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isEditable(element: Element | null): boolean {
  return element instanceof Element && element.matches(EDITABLE_SELECTOR);
}

export const Container = forwardRef<HTMLDivElement, ContainerProps>(function Container(
  { children, className, onPointerUp, onPointerUpCapture, ...props },
  ref,
) {
  /**
   * 拦掉 Video.js `Container` 在抬手时的抢焦点。
   *
   * 它在自己的 `onPointerUp` 里无条件调用 `focusContainer()`：只要当前焦点不在**它的
   * DOM 子树内**，就把焦点拉回舞台（舞台带 `tabindex="0"`）。而 HUD 与控制栏的菜单
   * 刻意 portal 到舞台之外（原生全屏的 top layer、网页全屏的 `overflow-clip` 都会吞掉
   * 留在里面的浮层），于是点菜单里的输入框时，按下先把焦点给了输入框，抬手又被舞台
   * 抢回去 —— 之后敲的字全落进舞台（播放器快捷键），表现为「定时关闭的分钟数、
   * 自动发送弹幕的内容都点不进去、打不了字」。
   *
   * 捕获阶段先于挂在同一个元素上的冒泡处理器执行，因此这里能提前收手。判据用
   * `document.activeElement` 而不是事件目标：点标签让输入框获得焦点时目标并不是输入框
   * 本身，而要看的是「浏览器已经把焦点放在了哪个字段上」。仅限舞台 DOM 之外的可编辑
   * 元素 —— 留在舞台内的那些（如画面内的弹幕输入框）本就不在 `focusContainer` 的
   * 抢焦点范围内。
   */
  const keepEditableFocus = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const active = document.activeElement;
    if (!isEditable(active) || !(active instanceof Node)) return;
    const stage = event.currentTarget;
    if (stage.contains(active)) return;
    event.stopPropagation();
  }, []);

  return (
    <ContainerPrimitive
      ref={ref}
      onPointerUpCapture={onPointerUpCapture ?? keepEditableFocus}
      onPointerUp={onPointerUp}
      className={cn(
        "media-skin",
        "relative isolate block h-full w-full overflow-clip bg-media-background @container/media-root [container-type:size]",
        "[--spacing:var(--media-spacing)] font-media text-media leading-normal subpixel-antialiased",
        "after:pointer-events-none after:absolute after:inset-0 after:z-10",
        "after:shadow-[inset_0_0_0_1px_var(--media-frame-border)] [&:fullscreen]:after:hidden",
        className,
      )}
      {...props}
    >
      {children}
    </ContainerPrimitive>
  );
});
