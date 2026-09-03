import { cn } from "@/lib/utils";
import { VIDEO_TABS, VIDEO_TAB_LABELS, type VideoTab } from "./videoRoute";

/**
 * 视频页头部的四个内容页签。
 *
 * 画法对齐 `SiteSwitcher`（同高、同 `role="tablist"`、同底部指示条），因为它顶的正是
 * 头部那条平台 bar 的位置。但**刻意不是** `SiteSwitcher`：那个组件的条目是直播平台，
 * 与这四个内容页签混进同一条轨道会让 Shell 的页面平移把两种语义当成同一个条带。
 */
export function VideoTabSwitcher({
  value,
  onValueChange,
  className,
}: {
  value: VideoTab;
  onValueChange: (tab: VideoTab) => void;
  className?: string;
}) {
  return (
    <div
      className={cn("flex h-full items-stretch gap-1 max-md:w-full", className)}
      role="tablist"
      aria-label="视频内容"
    >
      {VIDEO_TABS.map((tab) => {
        const active = tab === value;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            data-motion-control
            aria-selected={active}
            title={VIDEO_TAB_LABELS[tab]}
            onClick={() => onValueChange(tab)}
            className={cn(
              "relative flex h-full items-center gap-2 px-4 text-sm font-medium transition-colors duration-150 focus-ring max-md:min-w-0 max-md:flex-1 max-md:justify-center max-md:px-2",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
            )}
          >
            {VIDEO_TAB_LABELS[tab]}
            {active && (
              <span
                className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary"
                aria-hidden
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
