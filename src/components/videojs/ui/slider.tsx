import "../styles/theme.css";
import type { ComponentProps } from "react";

import { cn } from "@/components/videojs/lib/resolve-class-name";

/** Shared slider track. */
export type SliderTrackProps = ComponentProps<"div">;

export function SliderTrack({ className, ...props }: SliderTrackProps) {
  return (
    <div
      className={cn(
        "relative isolate w-full select-none overflow-hidden rounded-media-pill bg-current/20 data-[orientation=horizontal]:h-1 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1",
        className,
      )}
      {...props}
    />
  );
}

/** Shared slider fill. */
export type SliderFillProps = ComponentProps<"div">;

export function SliderFill({ className, ...props }: SliderFillProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute rounded-[inherit] transition-[clip-path] duration-media-slider ease-out group-data-dragging/slider:duration-0 group-data-seeking/slider:duration-0 group-focus-within/slider:duration-0 bg-media-primary data-[orientation=horizontal]:inset-y-0 data-[orientation=horizontal]:left-0 data-[orientation=horizontal]:w-full data-[orientation=horizontal]:clip-media-x-[--media-slider-fill] group-data-dragging/slider:data-[orientation=horizontal]:clip-media-x-[--media-slider-pointer] data-[orientation=vertical]:inset-x-0 data-[orientation=vertical]:bottom-0 data-[orientation=vertical]:h-full data-[orientation=vertical]:clip-media-y-[--media-slider-fill] group-data-dragging/slider:data-[orientation=vertical]:clip-media-y-[--media-slider-pointer]",
        className,
      )}
      {...props}
    />
  );
}

/** Shared slider buffer. */
export type SliderBufferProps = ComponentProps<"div">;

export function SliderBuffer({ className, ...props }: SliderBufferProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute rounded-[inherit] transition-[clip-path] duration-media-slider ease-out group-data-dragging/slider:duration-0 group-data-seeking/slider:duration-0 group-focus-within/slider:duration-0 bg-current/20 data-[orientation=horizontal]:inset-y-0 data-[orientation=horizontal]:left-0 data-[orientation=horizontal]:w-full data-[orientation=horizontal]:clip-media-x-[--media-slider-buffer] data-[orientation=vertical]:inset-x-0 data-[orientation=vertical]:bottom-0 data-[orientation=vertical]:h-full data-[orientation=vertical]:clip-media-y-[--media-slider-buffer]",
        className,
      )}
      {...props}
    />
  );
}

/** Shared slider thumb. */
export type SliderThumbProps = ComponentProps<"div">;

export function SliderThumb({ className, ...props }: SliderThumbProps) {
  return (
    <div
      className={cn(
        "absolute z-10 top-1/2 left-(--media-slider-fill) size-3 -translate-x-1/2 -translate-y-1/2 rounded-media-control bg-current select-none transition-[opacity,height,width,outline-offset,left,top,scale] duration-media-slider ease-out group-data-dragging/slider:transition-[opacity,height,width,outline-offset,scale] group-focus-within/slider:transition-[opacity,height,width,outline-offset,scale] group-data-dragging/slider:scale-90 data-[orientation=vertical]:top-[calc(100%-var(--media-slider-fill))] data-[orientation=vertical]:left-1/2 group-data-dragging/slider:data-[orientation=horizontal]:left-(--media-slider-pointer) group-data-dragging/slider:data-[orientation=vertical]:top-[calc(100%-var(--media-slider-pointer))] outline-transparent shadow-media-thumb outline-4 -outline-offset-4 hover:outline-current/15 hover:outline-offset-0 focus-visible:outline-current/15 focus-visible:outline-offset-0 after:pointer-events-none after:absolute after:-inset-1 after:scale-50 after:rounded-[inherit] after:opacity-0 after:shadow-[0_0_0_2px_currentColor] after:transition-[opacity,scale] after:duration-media-base after:ease-out focus-visible:after:scale-100 focus-visible:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}
