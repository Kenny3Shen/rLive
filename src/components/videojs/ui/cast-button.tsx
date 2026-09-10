import "../styles/theme.css";
import { CastButton as CastButtonPrimitive } from "@videojs/react";
import {
  CastEnterIcon as CastEnterIconPrimitive,
  CastExitIcon as CastExitIconPrimitive,
} from "@videojs/react/icons";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { Button } from "@/components/videojs/ui/button";

export type CastButtonProps = Omit<CastButtonPrimitive.Props, "children">;

export function CastButton({ className, ...props }: CastButtonProps = {}) {
  return (
    <CastButtonPrimitive
      render={<Button />}
      className={(state) => cn("group/cast", resolveClassName(className, state))}
      {...props}
    >
      <CastEnterIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-not-data-[cast-state=connected]/cast:scale-100",
          "group-not-data-[cast-state=connected]/cast:opacity-100",
        )}
      />
      <CastExitIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-data-[cast-state=connected]/cast:scale-100",
          "group-data-[cast-state=connected]/cast:opacity-100",
        )}
      />
    </CastButtonPrimitive>
  );
}
