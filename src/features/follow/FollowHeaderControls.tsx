import { RadioTower, Tv } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FollowView } from "./followRoute";

const FOLLOW_VIEWS: readonly FollowView[] = ["live", "iptv"];

const VIEW_LABELS: Record<FollowView, string> = {
  live: "直播关注",
  iptv: "IPTV 频道",
};

const VIEW_ICONS = {
  live: RadioTower,
  iptv: Tv,
} as const;

export function FollowViewSwitcher({
  value,
  liveCount,
  iptvCount,
  onValueChange,
  className,
}: {
  value: FollowView;
  liveCount: number | undefined;
  iptvCount: number | undefined;
  onValueChange: (view: FollowView) => void;
  className?: string;
}) {
  return (
    <div
      className={cn("flex h-full items-stretch gap-1 max-md:w-full", className)}
      role="tablist"
      aria-label="关注类型"
    >
      {FOLLOW_VIEWS.map((view) => {
        const active = view === value;
        const Icon = VIEW_ICONS[view];
        const count = view === "live" ? liveCount : iptvCount;
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
              "relative flex h-full items-center gap-2 px-4 text-sm font-medium transition-colors duration-150 focus-ring max-md:min-w-0 max-md:flex-1 max-md:justify-center",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span>{VIEW_LABELS[view]}</span>
            {count !== undefined && (
              <Badge variant="secondary" className="min-w-5 justify-center px-1.5 tabular-nums">
                {count}
              </Badge>
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
