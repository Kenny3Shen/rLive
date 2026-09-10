import "../styles/theme.css";
import { PiPButton as PiPButtonPrimitive } from "@videojs/react";
import {
  PipEnterIcon as PipEnterIconPrimitive,
  PipExitIcon as PipExitIconPrimitive,
} from "@videojs/react/icons";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { Button } from "@/components/videojs/ui/button";

export type PiPButtonProps = Omit<PiPButtonPrimitive.Props, "children">;

export function PiPButton({ className, ...props }: PiPButtonProps = {}) {
  return (
    <PiPButtonPrimitive
      render={<Button />}
      className={(state) => cn("group/pip", resolveClassName(className, state))}
      {...props}
    >
      <PipEnterIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-not-data-pip/pip:scale-100 group-not-data-pip/pip:opacity-100",
        )}
      />
      <PipExitIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-media-icon drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-data-pip/pip:scale-100 group-data-pip/pip:opacity-100",
        )}
      />
    </PiPButtonPrimitive>
  );
}
