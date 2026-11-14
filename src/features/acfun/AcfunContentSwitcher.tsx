import { BookOpenText, Clapperboard } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ACFUN_VIEW_LABELS, ACFUN_VIEWS, type AcfunView } from "./acfunRoute";

const ICONS = {
  video: Clapperboard,
  article: BookOpenText,
} as const;

export function AcfunContentSwitcher({
  value,
  onValueChange,
  iconOnly = false,
  className,
}: {
  value: AcfunView;
  onValueChange: (view: AcfunView) => void;
  iconOnly?: boolean;
  className?: string;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (next === "video" || next === "article") onValueChange(next);
      }}
      aria-label="AcFun 内容"
      className={cn("h-full gap-0", className)}
    >
      <TabsList variant="line" className="h-full! min-w-0 bg-transparent max-md:w-full">
        {ACFUN_VIEWS.map((view) => {
          const Icon = ICONS[view];
          return (
            <TabsTrigger
              key={view}
              value={view}
              aria-label={ACFUN_VIEW_LABELS[view]}
              title={ACFUN_VIEW_LABELS[view]}
              className="px-4 pointer-coarse:h-full! max-md:min-w-0 max-md:flex-1 max-md:px-2"
            >
              <Icon
                className={cn("hidden size-5 shrink-0 max-md:block", iconOnly && "md:block")}
                aria-hidden
              />
              <span className={cn("max-md:hidden", iconOnly && "hidden")}>
                {ACFUN_VIEW_LABELS[view]}
              </span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
