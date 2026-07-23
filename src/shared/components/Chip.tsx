import { X } from "lucide-react";
import { cn } from "@/lib/utils";

type ChipProps = {
  active?: boolean;
  onClick?: () => void;
  onClear?: () => void;
  children: React.ReactNode;
  className?: string;
};

export function Chip({
  active,
  onClick,
  onClear,
  children,
  className,
}: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-ring",
        active
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border bg-card text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
        className,
      )}
    >
      {children}
      {onClear && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="rounded-full p-0.5 hover:bg-white/10"
          aria-label="清除"
        >
          <X className="h-3 w-3" />
        </span>
      )}
    </button>
  );
}
