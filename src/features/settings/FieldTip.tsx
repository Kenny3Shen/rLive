import { useId, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMobileClient } from "@/shared/clientPlatform";

/**
 * 设置页中的内联信息图标，取代静态的 FieldDescription 文案；
 * 把触发器放在带标签的元素之外，保持 aria-labelledby 目标干净。
 */
export function FieldTip({ children }: { children: ReactNode }) {
  const mobile = isMobileClient();
  const triggerId = useId();
  const [open, setOpen] = useState(false);

  return (
    <Tooltip {...(mobile ? { open, onOpenChange: setOpen, triggerId } : {})}>
      <TooltipTrigger
        closeOnClick={!mobile}
        id={triggerId}
        render={
          <button
            type="button"
            aria-label="查看说明"
            aria-expanded={mobile ? open : undefined}
            onClick={mobile ? () => setOpen((value) => !value) : undefined}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-ring"
          />
        }
      >
        <Info className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}
