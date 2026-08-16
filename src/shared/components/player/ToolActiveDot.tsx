import { cn } from "@/lib/utils";

type ToolActiveDotProps = {
  /** Accent color: `primary` for enabled tools, `destructive` for recording. */
  tone?: "primary" | "destructive";
  className?: string;
};

/**
 * Small corner dot marking a title-bar tool button (录制、定时关闭、自动发送弹幕)
 * as switched on. Render inside the icon-button's `relative` icon wrapper.
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
