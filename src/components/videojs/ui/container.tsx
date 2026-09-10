import "../styles/theme.css";
import { forwardRef } from "react";
import { Container as ContainerPrimitive } from "@videojs/react";

import { cn } from "@/components/videojs/lib/resolve-class-name";

export interface ContainerProps extends Omit<ContainerPrimitive.Props, "children"> {
  children?: ContainerPrimitive.Props["children"];
}

export const Container = forwardRef<HTMLDivElement, ContainerProps>(function Container(
  { children, className, ...props },
  ref,
) {
  return (
    <ContainerPrimitive
      ref={ref}
      className={cn(
        "media-skin",
        "relative isolate block h-full w-full overflow-clip rounded-media-player bg-media-background @container/media-root [container-type:size]",
        "[--spacing:var(--media-spacing)] font-media text-media leading-normal subpixel-antialiased",
        "outline-2 -outline-offset-4 outline-transparent transition-[outline-offset,outline-color] duration-media-fast ease-out",
        "focus-visible:outline-media-ring focus-visible:outline-offset-2",
        "after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit]",
        "after:shadow-[inset_0_0_0_1px_var(--media-frame-border)] [&:fullscreen]:after:hidden",
        className,
      )}
      {...props}
    >
      {children}
    </ContainerPrimitive>
  );
});
