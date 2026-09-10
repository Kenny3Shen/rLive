import "../styles/theme.css";
import { FullscreenButton as FullscreenButtonPrimitive } from "@videojs/react";
import { Maximize2, Minimize2 } from "lucide-react";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { Button } from "@/components/videojs/ui/button";

export type FullscreenButtonProps = Omit<FullscreenButtonPrimitive.Props, "children">;

export function FullscreenButton({ className, ...props }: FullscreenButtonProps = {}) {
  return (
    <FullscreenButtonPrimitive
      render={<Button />}
      className={(state) => cn("group/fullscreen r-live-media-extension-button", resolveClassName(className, state))}
      {...props}
    >
      <Maximize2
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-not-data-fullscreen/fullscreen:scale-100 group-not-data-fullscreen/fullscreen:opacity-100",
        )}
      />
      <Minimize2
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-data-fullscreen/fullscreen:scale-100 group-data-fullscreen/fullscreen:opacity-100",
        )}
      />
    </FullscreenButtonPrimitive>
  );
}
