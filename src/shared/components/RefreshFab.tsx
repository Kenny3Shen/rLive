import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isMobileClient } from "@/shared/clientPlatform";

type RefreshFabProps = {
  onRefresh: () => void | Promise<unknown>;
  /** 刷新在途时禁用控件并显示转圈。 */
  pending?: boolean;
  label?: string;
  className?: string;
};

const RefreshFabVisibilityContext = createContext(true);

export function RefreshFabVisibilityProvider({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <RefreshFabVisibilityContext.Provider value={visible}>
      {children}
    </RefreshFabVisibilityContext.Provider>
  );
}

/**
 * 列表页的桌面手动刷新控件。
 *
 * 列表查询刻意在首次访问后绝不自行重新抓取，
 * 因此桌面客户端用这个按钮、移动客户端用下拉刷新。
 *
 * 它渲染进 `document.body`：Shell 的页面包装层因入场动画持有合成 transform,
 * 否则会成为 fixed 子元素的包含块，使按钮随内容滚走。
 */
export function RefreshFab({
  onRefresh,
  pending = false,
  label = "刷新",
  className,
}: RefreshFabProps) {
  const visible = useContext(RefreshFabVisibilityContext);
  if (!visible || isMobileClient()) return null;

  return createPortal(
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-slot="refresh-fab"
            type="button"
            aria-label={label}
            disabled={pending}
            onClick={() => void onRefresh()}
            className={cn(
              "fixed right-4 bottom-4 z-30 size-11 rounded-full p-0 shadow-lg shadow-black/25 md:right-5 md:bottom-5",
              // 清除移动端底部导航栏与设备 inset。
              "max-md:bottom-[calc(5rem+env(safe-area-inset-bottom))]",
              className,
            )}
          />
        }
      >
        {pending ? (
          <Spinner className="size-5" aria-hidden />
        ) : (
          <RefreshCw className="size-5" aria-hidden />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>,
    document.body,
  );
}
