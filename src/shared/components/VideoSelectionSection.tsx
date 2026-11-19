import { ChevronDown } from "lucide-react";
import { type ReactNode, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  VIDEO_DETAILS_SIDEBAR_CARD_CLASS,
  VIDEO_DETAILS_SELECTION_TRIGGER_CLASS,
} from "@/shared/components/videoDetailsSidebar";

/** 分集、合集和多 P 选集共用的紧凑行；显式行高避免跟随宿主页签的字号继承漂移。 */
export function VideoSelectionRow({
  current,
  label,
  title,
  duration,
  rowRef,
  onNavigate,
}: {
  current: boolean;
  label: string;
  title: string;
  duration: string;
  rowRef?: Ref<HTMLButtonElement>;
  onNavigate: () => void;
}) {
  return (
    <button
      ref={rowRef}
      type="button"
      aria-current={current || undefined}
      onClick={onNavigate}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left leading-normal transition-colors hover:bg-muted/50",
        current && "bg-primary/10",
      )}
    >
      <span
        className={cn(
          "min-w-7 shrink-0 text-center text-xs tabular-nums",
          current ? "font-semibold text-primary" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{duration}</span>
    </button>
  );
}

/** 分集、合集和多 P 选集共用的可折叠卡片标题。 */
export function VideoSelectionSection({
  label,
  title,
  count,
  open,
  onOpenChange,
  className,
  children,
}: {
  label: string;
  title?: string;
  count: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      render={
        <section
          data-slot="video-selection-card"
          className={cn("shrink-0 overflow-hidden", VIDEO_DETAILS_SIDEBAR_CARD_CLASS, className)}
        />
      }
      aria-label={title ? `${label}：${title}` : label}
    >
      <h3>
        <CollapsibleTrigger
          render={
            <Button variant="ghost" size="sm" className={VIDEO_DETAILS_SELECTION_TRIGGER_CLASS} />
          }
        >
          <ChevronDown
            aria-hidden
            data-icon="inline-start"
            className={cn("transition-transform", !open && "-rotate-90")}
          />
          <span className="shrink-0">{label}</span>
          {title && <span className="min-w-0 flex-1 truncate text-left">{title}</span>}
          <span className="ml-auto shrink-0 font-normal tabular-nums text-muted-foreground">
            {count}
          </span>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent inert={!open || undefined}>{children}</CollapsibleContent>
    </Collapsible>
  );
}
