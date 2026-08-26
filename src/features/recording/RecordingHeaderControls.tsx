import { CircleDot, HardDrive, Videotape } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
 * 录制库作用域切换器，在 `/recordings` 上取代应用头部的平台条。它与历史切换器
 * 一样是 `tablist`：
 * 各作用域是同一个页面的不同视图。
 */
export function RecordingViewSwitcher({
  value,
  counts,
  onValueChange,
  className,
}: {
  value: RecordingView;
  counts: Record<RecordingView, number>;
  onValueChange: (view: RecordingView) => void;
  className?: string;
}) {
  return (
    <div
      className={cn("flex h-full items-stretch gap-1 max-md:w-full", className)}
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
              "relative flex h-full items-center gap-2 px-4 text-sm font-medium transition-colors duration-150 focus-ring max-md:min-w-0 max-md:flex-1 max-md:justify-center max-md:px-2",
              active
                ? "text-foreground"
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
            <span>{VIEW_LABELS[view]}</span>
            {count > 0 && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
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

/** 打开录制页拥有的存储位置对话框。 */
export function RecordingStorageButton({
  onRequestStorage,
  className,
}: {
  onRequestStorage: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="录制保存位置"
            aria-haspopup="dialog"
            className={cn("shrink-0 max-md:h-9", className)}
            onClick={onRequestStorage}
          />
        }
      >
        <HardDrive data-icon="inline-start" aria-hidden />
        <span className="max-sm:hidden">保存位置</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">录制保存位置</TooltipContent>
    </Tooltip>
  );
}
