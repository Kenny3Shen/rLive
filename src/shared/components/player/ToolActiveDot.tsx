import { cn } from "@/lib/utils";

type ToolActiveDotProps = {
  /** 强调色：启用的工具用 `primary`，录制用 `destructive`。 */
  tone?: "primary" | "destructive";
  className?: string;
};

/**
 * 标记标题栏工具按钮（录制、定时关闭、自动发送弹幕）已开启的小角落圆点。
 * 渲染在图标按钮的 `relative` 图标包装层内部。
 */
export function ToolActiveDot({ tone = "primary", className }: ToolActiveDotProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -bottom-1 -right-1 size-1.5 rounded-full",
        tone === "destructive" ? "bg-destructive" : "bg-primary",
        className,
      )}
    />
  );
}
