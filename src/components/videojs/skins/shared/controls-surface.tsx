import "../../styles/theme.css";
import { Controls, Tooltip } from "@videojs/react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/components/videojs/lib/resolve-class-name";

/**
 * 控制层的显隐由各播放页已有的 chrome 管线驱动（`data-visible` + 指针/焦点计时器），
 * 因此这里的 ref、事件与定位类名整体由业务侧传入，原生 Controls 只负责内容。
 */
export type ControlsChromeProps = ComponentProps<"div"> &
  Record<`data-${string}`, string | number | boolean | undefined>;

export type SkinControlsProps = {
  chrome?: ControlsChromeProps;
  /** 控制条贴在窗口底边时避让系统手势栏。 */
  avoidSystemGestureBar?: boolean;
  pictureInPictureDisabled?: boolean;
  /**
   * 音量交给原生 VolumePopover。Android 的真实音量是系统媒体音量，原生组件只能写
   * 媒体元素，此时由业务侧渲染绑定原生桥的音量控件，避免两个控件写不同目标。
   */
  showVolumeControl?: boolean;
  /** 全屏交给浏览器原生按钮；业务自建全屏层时由业务侧渲染按钮。 */
  showFullscreenButton?: boolean;
  children?: ReactNode;
};

/**
 * 唯一的控制条表面：原生渐变背景 + 原生 Controls.Content 行。
 * `visibility="always"` 让 Video.js 不再自行收起，避免与业务的淡出管线互相打架。
 */
export function ControlsSurface({
  chrome,
  avoidSystemGestureBar,
  children,
}: Pick<SkinControlsProps, "chrome" | "avoidSystemGestureBar" | "children">) {
  const { className, ...chromeProps } = chrome ?? {};
  return (
    <Controls.Root visibility="always">
      <div className={cn(className)} {...chromeProps}>
        <Controls.Backdrop className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[calc(100%+var(--media-spacing)*8)] bg-(image:--media-controls-gradient)" />
        <Controls.Content
          className={cn(
            "relative z-10 flex w-full min-w-0 flex-col gap-0.5 px-1 pt-1",
            "text-media-controls-foreground text-shadow-media",
            avoidSystemGestureBar ? "pb-[max(0.25rem,env(safe-area-inset-bottom))]" : "pb-1",
          )}
        >
          <Tooltip.Provider>{children}</Tooltip.Provider>
        </Controls.Content>
      </div>
    </Controls.Root>
  );
}
