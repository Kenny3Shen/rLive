import "../styles/theme.css";
import { Maximize2, Minimize2 } from "lucide-react";

import { cn } from "@/components/videojs/lib/resolve-class-name";
import { Button } from "@/components/videojs/ui/button";

export type FullscreenButtonProps = {
  className?: string;
  onClick?: () => void;
  "aria-label"?: string;
  disabled?: boolean;
  fullscreen?: boolean;
};

export function FullscreenButton({
  className,
  fullscreen = false,
  ...props
}: FullscreenButtonProps = {}) {
  return (
    <Button
      className={cn("group/fullscreen r-live-media-extension-button", className)}
      data-fullscreen={fullscreen || undefined}
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
    </Button>
  );
}
