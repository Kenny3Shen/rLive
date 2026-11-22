import type { CSSProperties } from "react";
import { SpinnerIcon } from "@videojs/react/icons";
import { shortsMediaAreaStyle } from "./shortsFeed";

/**
 * 短视频首帧前的转圈。
 *
 * 位置绑定整个画面区而不是 `shorts-frame`。列表先验的 `dimension` 与媒体实测画幅
 * 不一致时，画面框会改写宽高与纵向落点；转圈若跟着它走，用户会在同一次加载里看到
 * 动画横竖跳位。这里只消费底栏与安全区，因此在 Suspense 骨架、feed 首屏和媒体首帧
 * 三个阶段都保持同一个中心。
 */
export function ShortsLoadingIndicator({
  safeAreaBottom = true,
  bottomBar = true,
}: {
  safeAreaBottom?: boolean;
  bottomBar?: boolean;
}) {
  return (
    <div
      aria-hidden
      data-slot="shorts-loading-indicator"
      className="pointer-events-none absolute inset-x-0 z-10 grid place-items-center text-media-controls-foreground"
      style={
        {
          ...shortsMediaAreaStyle(safeAreaBottom, bottomBar),
          ["--media-icon-size" as string]: "2rem",
        } as CSSProperties
      }
    >
      <SpinnerIcon className="size-media-icon drop-shadow-media-icon" />
    </div>
  );
}
