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
  /** Disables the control and shows a spinner while a refresh is in flight. */
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
 * Desktop manual-refresh control for list pages.
 *
 * List queries deliberately never refetch on their own after the first visit,
 * so desktop clients use this button while mobile clients use pull-to-refresh.
 *
 * It renders into `document.body`: the page wrapper in Shell keeps a composited
 * transform from its entrance animation, which would otherwise turn into the
 * containing block for a fixed child and make the button scroll away with the
 * content.
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
              // Clear the mobile bottom navigation bar and the device inset.
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
