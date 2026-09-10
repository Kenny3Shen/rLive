import "../styles/theme.css";
import { FullscreenButton as FullscreenButtonPrimitive } from "@videojs/react";
import {
  FullscreenEnterIcon as FullscreenEnterIconPrimitive,
  FullscreenExitIcon as FullscreenExitIconPrimitive,
} from "@videojs/react/icons";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { Button } from "@/components/videojs/ui/button";

export type FullscreenButtonProps = Omit<FullscreenButtonPrimitive.Props, "children">;

export function FullscreenButton({ className, ...props }: FullscreenButtonProps = {}) {
  return (
    <FullscreenButtonPrimitive
      render={<Button />}
      className={(state) => cn("group/fullscreen", resolveClassName(className, state))}
      {...props}
    >
      <FullscreenEnterIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-not-data-fullscreen/fullscreen:scale-100 group-not-data-fullscreen/fullscreen:opacity-100",
        )}
      />
      <FullscreenExitIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-data-fullscreen/fullscreen:scale-100 group-data-fullscreen/fullscreen:opacity-100",
        )}
      />
    </FullscreenButtonPrimitive>
  );
}
