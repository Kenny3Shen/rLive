import "../styles/theme.css";
import { MuteButton as MuteButtonPrimitive } from "@videojs/react";
import { Volume1, Volume2, VolumeX } from "lucide-react";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { Button } from "@/components/videojs/ui/button";

export type MuteButtonProps = Omit<MuteButtonPrimitive.Props, "children">;

export function MuteButton({ className, ...props }: MuteButtonProps = {}) {
  return (
    <MuteButtonPrimitive
      render={<Button />}
      className={(state) =>
        cn("group/mute r-live-media-extension-button", resolveClassName(className, state))
      }
      {...props}
    >
      <VolumeX
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-data-muted/mute:scale-100 group-data-muted/mute:opacity-100",
        )}
      />
      <Volume1
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0",
          "group-not-data-muted/mute:group-data-[volume-level=low]/mute:opacity-100",
          "group-not-data-muted/mute:group-data-[volume-level=low]/mute:scale-100",
        )}
      />
      <Volume2
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0",
          "group-not-data-muted/mute:group-not-data-[volume-level=low]/mute:opacity-100",
          "group-not-data-muted/mute:group-not-data-[volume-level=low]/mute:scale-100",
        )}
      />
    </MuteButtonPrimitive>
  );
}
