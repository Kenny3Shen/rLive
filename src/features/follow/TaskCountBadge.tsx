import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatTaskBadgeCount } from "./followTaskCounts";

/** 任务徽标的视觉数字封顶；完整数量由父级无障碍标签提供。 */
export function TaskCountBadge({
  count,
  variant = "secondary",
  className,
}: {
  count: number;
  variant?: "default" | "secondary" | "destructive" | "outline";
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <Badge
      data-slot="task-count-badge"
      variant={variant}
      aria-hidden="true"
      className={cn("h-5 min-w-5 rounded-full px-1.5 tabular-nums", className)}
    >
      {formatTaskBadgeCount(count)}
    </Badge>
  );
}
