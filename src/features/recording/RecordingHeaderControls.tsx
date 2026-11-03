import { CircleDot, HardDrive, Videotape } from "lucide-react";
import { cn } from "@/lib/utils";
import { RECORDING_VIEWS, type RecordingView } from "./recordingRoute";

const VIEW_LABELS: Record<RecordingView, string> = {
  all: "全部",
  recording: "录制中",
  recorded: "已录制",
};

const VIEW_ICONS = {
  all: Videotape,
  recording: CircleDot,
  recorded: HardDrive,
} as const;

/**
 * 录制库作用域切换器。
 *
 * `sidebar` 是桌面左侧筛选框里的纵向列表，与平台筛选、用户列表同一列；
 * `toolbar` 只留给移动端没有左栏时的横向页签。各作用域是同一个页面的不同视图。
 */
export function RecordingViewSwitcher({
  value,
  counts,
  onValueChange,
  variant = "toolbar",
  className,
}: {
  value: RecordingView;
  counts: Record<RecordingView, number>;
  onValueChange: (view: RecordingView) => void;
  variant?: "sidebar" | "toolbar";
  className?: string;
}) {
  const sidebar = variant === "sidebar";

  return (
    <div
      className={cn(
        sidebar ? "flex flex-col gap-1" : "flex h-full items-stretch gap-1 max-md:w-full",
        className,
      )}
      role="tablist"
      aria-label="录制范围"
    >
      {RECORDING_VIEWS.map((view) => {
        const active = view === value;
        const Icon = VIEW_ICONS[view];
        const count = counts[view];
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
              sidebar
                ? "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-medium transition-colors duration-150"
                : "relative flex h-full items-center gap-2 px-4 text-sm font-medium transition-colors duration-150 max-md:min-w-0 max-md:flex-1 max-md:justify-center max-md:px-2",
              active
                ? sidebar
                  ? "bg-secondary text-foreground"
                  : "text-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
            )}
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                view === "recording" && count > 0 && "text-destructive",
              )}
              aria-hidden
            />
            <span className={cn(sidebar && "min-w-0 flex-1 truncate text-left")}>
              {VIEW_LABELS[view]}
            </span>
            {count > 0 && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
            )}
            {!sidebar && active && (
              <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}
