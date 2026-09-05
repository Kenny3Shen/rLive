import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";

export type DrawerSide = "bottom" | "right";

const DrawerScopeContext = React.createContext<{
  container: HTMLDivElement | null;
  setContainer: React.Dispatch<React.SetStateAction<HTMLDivElement | null>>;
} | null>(null);

/** 播放页共用侧栏挂载点，播放器和顶栏触发的抽屉也能进入同一范围。 */
function DrawerScope({ children }: { children: React.ReactNode }) {
  const [container, setContainer] = React.useState<HTMLDivElement | null>(null);
  const value = React.useMemo(() => ({ container, setContainer }), [container]);
  return <DrawerScopeContext value={value}>{children}</DrawerScopeContext>;
}

/** 放在侧栏的定位容器内，独立于滚动区和带 transform 的页签轨道。 */
function DrawerViewport({ active = true }: { active?: boolean }) {
  const setContainer = React.useContext(DrawerScopeContext)?.setContainer;
  if (!setContainer || !active) return null;
  return (
    <div
      ref={setContainer}
      data-slot="drawer-viewport"
      className="pointer-events-none absolute inset-0 isolate z-50 overflow-clip [contain:layout_paint]"
    />
  );
}

function Drawer({ actionsRef, modal = true, ...props }: DialogPrimitive.Root.Props) {
  const container = React.useContext(DrawerScopeContext)?.container;
  const internalActionsRef = React.useRef<DialogPrimitive.Root.Actions | null>(null);
  const actions = actionsRef ?? internalActionsRef;
  const previousContainer = React.useRef(container);

  React.useLayoutEffect(() => {
    // 收起侧栏或进入全屏时关闭原来的局部抽屉，避免它跳到全窗口。
    if (previousContainer.current && previousContainer.current !== container) {
      actions.current?.close();
    }
    previousContainer.current = container;
  }, [actions, container]);

  return (
    <DialogPrimitive.Root
      data-slot="drawer"
      actionsRef={actions}
      modal={container ? false : modal}
      {...props}
    />
  );
}

function DrawerTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  const scoped = Boolean(React.useContext(DrawerScopeContext)?.container);
  return (
    <DialogPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        "motion-dialog-overlay pointer-events-auto inset-0 isolate z-50 bg-overlay",
        scoped ? "absolute" : "fixed",
        className,
      )}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  side = "bottom",
  container,
  glass = false,
  ...props
}: DialogPrimitive.Popup.Props & {
  side?: DrawerSide;
  container?: DialogPrimitive.Portal.Props["container"];
  /* 选择毛玻璃材质。启用后放弃默认的 `bg-popover`，
     让玻璃质感的 `::before` 填充透过模糊背景显现。 */
  glass?: boolean;
}) {
  const scopedContainer = React.useContext(DrawerScopeContext)?.container;
  return (
    <DrawerPortal container={scopedContainer ?? container}>
      <DrawerOverlay />
      <DialogPrimitive.Popup
        data-slot="drawer-content"
        data-side={side}
        data-scoped={scopedContainer ? "" : undefined}
        className={cn(
          "motion-drawer pointer-events-auto fixed z-50 text-popover-foreground shadow-lg outline-none",
          !glass && "bg-popover",
          glass && "glass-surface",
          side === "bottom" &&
            "inset-x-0 bottom-0 max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border border-border p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]",
          side === "right" &&
            "inset-y-0 right-0 h-full w-[min(20rem,60vw)] max-w-full overflow-y-auto rounded-l-2xl border border-border p-4 pr-[calc(1rem+env(safe-area-inset-right))]",
          className,
          scopedContainer && "absolute max-h-full w-full rounded-none",
        )}
        {...props}
      />
    </DrawerPortal>
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="drawer-title"
      className={cn("font-heading text-base font-medium", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function DrawerClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="drawer-close" {...props} />;
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerOverlay,
  DrawerPortal,
  DrawerScope,
  DrawerTitle,
  DrawerTrigger,
  DrawerViewport,
};
