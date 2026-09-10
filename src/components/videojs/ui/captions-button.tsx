import "../styles/theme.css";
import { CaptionsButton as CaptionsButtonPrimitive } from "@videojs/react";
import {
  CaptionsOffIcon as CaptionsOffIconPrimitive,
  CaptionsOnIcon as CaptionsOnIconPrimitive,
} from "@videojs/react/icons";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { Button } from "@/components/videojs/ui/button";

export type CaptionsButtonProps = Omit<CaptionsButtonPrimitive.Props, "children">;

export function CaptionsButton({ className, ...props }: CaptionsButtonProps = {}) {
  return (
    <CaptionsButtonPrimitive
      render={<Button />}
      className={(state) => cn("group/captions", resolveClassName(className, state))}
      {...props}
    >
      <CaptionsOffIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-not-data-active/captions:scale-100 group-not-data-active/captions:opacity-100",
        )}
      />
      <CaptionsOnIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-data-active/captions:scale-100 group-data-active/captions:opacity-100",
        )}
      />
    </CaptionsButtonPrimitive>
  );
}
