"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";

import { cn } from "@/lib/utils";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

const Select = SelectPrimitive.Root;

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  size = "default",
  glass = false,
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default";
  /** 玻璃面板内的触发器：悬停填充与面板一致，避免不透明 token 在材质上凿洞。 */
  glass?: boolean;
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none touch-manipulation disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-0 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] [@media(pointer:coarse)]:min-h-11 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        glass ? "text-white hover:bg-white/12" : "hover:bg-muted",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDownIcon
            className={cn(
              "pointer-events-none size-4",
              glass ? "text-white/60" : "text-muted-foreground",
            )}
          />
        }
      />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  // Base UI 默认使用原生 select 的几何形态，会把弹层抬起、让选中项盖住触发器。
  // 过滤器需要触发器保持可见，因此默认锚定在其下方，
  // 调用方可显式选择退回原行为。
  alignItemWithTrigger = false,
  container,
  glass = false,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  > & {
    /** 供渲染在全屏元素内部的控件使用的 Portal 目标。 */
    container?: HTMLElement | React.RefObject<HTMLElement | null> | null;
    /** 使用经 className 注入的项目玻璃材质。 */
    glass?: boolean;
  }) {
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn(
            "motion-popup relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg",
            // 玻璃材质的填充、边框与阴影由调用方经 className 注入（见 glassSurface.ts）；
            // 这里必须连描边和阴影一起让出，否则不透明的 token 会压在材质上。
            !glass && "border border-border bg-popover text-popover-foreground shadow-lg",
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton glass={glass} />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton glass={glass} />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  glass = false,
  children,
  ...props
}: SelectPrimitive.Item.Props & {
  /** 使用与玻璃面板一致的悬停/选中填充，避免不透明 token 在材质上凿洞。 */
  glass?: boolean;
}) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-1.5 pl-1.5 text-sm outline-hidden select-none touch-manipulation data-disabled:pointer-events-none data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        // 玻璃面板里的悬停/选中填充由调用方经 glassOptionClass 注入；
        // 这里让出默认的不透明 token，避免在材质上凿洞。
        !glass &&
          "hover:bg-muted hover:text-foreground data-highlighted:bg-muted data-highlighted:text-foreground data-selected:bg-secondary data-selected:text-secondary-foreground data-selected:hover:bg-secondary data-selected:data-highlighted:bg-secondary",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  glass = false,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow> & { glass?: boolean }) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-4",
        glass ? "bg-transparent text-white/70" : "bg-popover",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  glass = false,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow> & { glass?: boolean }) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-4",
        glass ? "bg-transparent text-white/70" : "bg-popover",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
