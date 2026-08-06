import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";

export type DrawerSide = "bottom" | "right";

function Drawer({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-overlay duration-200 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
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
  /* Opt into the frosted material. When set, the default `bg-popover` is
     dropped so the glass `::before` fill shows the blurred backdrop through. */
  glass?: boolean;
}) {
  return (
    <DrawerPortal container={container}>
      <DrawerOverlay />
      <DialogPrimitive.Popup
        data-slot="drawer-content"
        data-side={side}
        className={cn(
          "fixed z-50 text-popover-foreground shadow-lg outline-none",
          !glass && "bg-popover",
          glass && "glass-surface",
          side === "bottom" &&
            "inset-x-0 bottom-0 max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border border-border p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] data-open:animate-drawer-in-bottom data-closed:animate-drawer-out-bottom",
          side === "right" &&
            "inset-y-0 right-0 h-full w-[min(22rem,85vw)] max-w-full overflow-y-auto rounded-l-2xl border border-border p-4 pr-[calc(1rem+env(safe-area-inset-right))] data-open:animate-drawer-in-right data-closed:animate-drawer-out-right",
          className,
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
  DrawerTitle,
  DrawerTrigger,
};
