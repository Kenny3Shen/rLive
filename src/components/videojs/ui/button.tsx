import "../styles/theme.css";
import type { ComponentProps } from "react";

import { cn } from "@/components/videojs/lib/resolve-class-name";

/** Shared button carrying the base interactive styles used by media controls. */
export type ButtonProps = ComponentProps<"button">;

export function Button({ className, ...props }: ButtonProps) {
  return (
    <button
      // 静止态不声明 will-change：按钮文字会被单独栅格化，在分数像素比下发虚。
      className={cn(
        "grid size-media-control min-h-0 shrink-0 touch-manipulation select-none place-items-center rounded-media-control border-0 bg-transparent p-0 text-center text-inherit [corner-shape:var(--media-control-corner-shape)] [text-shadow:inherit] cursor-pointer duration-media-base ease-out [transition-property:background-color,color,scale] media-highlighted:highlight-media not-aria-disabled:active:scale-[0.97] motion-reduce:scale-100 motion-reduce:[transition-property:background-color,color] aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
