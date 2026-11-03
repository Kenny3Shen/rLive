import { useEffect, useRef } from "react";
import { Clapperboard, Download, RadioTower, Tv, Videotape } from "lucide-react";
import { activeRecordingCount, useActiveRecordings } from "@/features/recording/recording";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import { followViewsFor, type FollowView } from "./followRoute";

const VIEW_LABELS: Record<FollowView, string> = {
  live: "直播",
  video: "视频",
  iptv: "IPTV",
  recordings: "录制",
  downloads: "下载",
};

const VIEW_ICONS = {
  live: RadioTower,
  video: Clapperboard,
  iptv: Tv,
  recordings: Videotape,
  downloads: Download,
} as const;

export function FollowViewSwitcher({
  value,
  onValueChange,
  recordingAvailable,
  className,
}: {
  value: FollowView;
  onValueChange: (view: FollowView) => void;
  recordingAvailable: boolean;
  className?: string;
}) {
  const views = followViewsFor(recordingAvailable);
  const activeRecordings = useActiveRecordings(recordingAvailable);
  const recordingCount = activeRecordingCount(activeRecordings.data);
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tabList = tabListRef.current;
    if (!tabList || tabList.scrollWidth <= tabList.clientWidth) return;
    const activeTab = tabList.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    activeTab?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [recordingAvailable, value]);

  return (
    <div
      ref={tabListRef}
      className={cn(
        "flex h-full items-stretch gap-1 max-md:w-full max-md:min-w-0 max-md:justify-start max-md:overflow-x-auto max-md:overscroll-x-contain max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden",
        className,
      )}
      role="tablist"
      aria-label="关注类型"
    >
      {views.map((view) => {
        const active = view === value;
        const Icon = VIEW_ICONS[view];
        return (
          <button
            key={view}
            type="button"
            role="tab"
            data-motion-control
            aria-selected={active}
            title={VIEW_LABELS[view]}
            onClick={() => onValueChange(view)}
            className={cn(
              "relative flex h-full shrink-0 items-center gap-2 px-4 text-sm font-medium whitespace-nowrap transition-colors duration-150 max-md:justify-center max-md:gap-1.5 max-md:px-3",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span>{VIEW_LABELS[view]}</span>
            {view === "recordings" && recordingCount > 0 && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {recordingCount}
              </span>
            )}
            {active && (
              <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}
