import "../styles/theme.css";
import { AirPlayButton as AirPlayButtonPrimitive } from "@videojs/react";
import {
  AirPlayEnterIcon as AirPlayEnterIconPrimitive,
  AirPlayExitIcon as AirPlayExitIconPrimitive,
} from "@videojs/react/icons";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { Button } from "@/components/videojs/ui/button";

export type AirPlayButtonProps = Omit<AirPlayButtonPrimitive.Props, "children">;

export function AirPlayButton({ className, ...props }: AirPlayButtonProps = {}) {
  return (
    <AirPlayButtonPrimitive
      render={<Button />}
      className={(state) =>
        cn(
          "group/airplay",
          "not-data-[airplay-state=connected]:[--media-icon-airplay-fill-animation:none]",
          "not-data-[airplay-state=connected]:[--media-icon-airplay-triangle-animation:none]",
          resolveClassName(className, state),
        )
      }
      {...props}
    >
      <AirPlayEnterIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-not-data-[airplay-state=connected]/airplay:scale-100",
          "group-not-data-[airplay-state=connected]/airplay:opacity-100",
        )}
      />
      <AirPlayExitIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-data-[airplay-state=connected]/airplay:scale-100",
          "group-data-[airplay-state=connected]/airplay:opacity-100",
        )}
      />
    </AirPlayButtonPrimitive>
  );
}
