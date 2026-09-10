import "../styles/theme.css";
import { VolumeIndicator as VolumeIndicatorPrimitive } from "@videojs/react";
import {
  VolumeHighIcon as VolumeHighIconPrimitive,
  VolumeLowIcon as VolumeLowIconPrimitive,
  VolumeOffIcon as VolumeOffIconPrimitive,
} from "@videojs/react/icons";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";

export type VolumeIndicatorProps = Omit<VolumeIndicatorPrimitive.RootProps, "children">;

export function VolumeIndicator({ className, ...props }: VolumeIndicatorProps = {}) {
  return (
    <VolumeIndicatorPrimitive.Root
      className={(state) =>
        cn(
          "pointer-events-none absolute origin-top",
          "duration-media-fast ease-out",
          "media-transitioning:opacity-0 media-transitioning:duration-media-indicator media-transitioning:ease-in",
          "top-3 rounded-media-control font-medium",
          "bg-media-backdrop/25 text-media-popover-foreground surface-media after:surface-media-inset",
          "media-opaque:bg-media-background",
          "pointer-coarse:motion-media-[scale,translate,opacity]",
          "pointer-fine:motion-media-[scale,translate,filter,opacity]",
          "pointer-fine:media-transitioning:scale-media-hidden-indicator pointer-fine:media-transitioning:blur-media-hidden",
          "data-ending-style:translate-y-media-hidden-indicator-offset",
          "group/volume-status",
          "w-[min(80%,12rem)] [transform:translateX(0)]",
          "motion-safe:[&:is([data-min],[data-max]):not([data-starting-style],[data-ending-style])]:nudge-media",
          resolveClassName(className, state),
        )
      }
      {...props}
    >
      <VolumeIndicatorPrimitive.Fill
        className={cn(
          "items-center justify-between gap-2 px-2.5 py-1",
          "rounded-[inherit]",
          "flex w-full bg-left bg-no-repeat",
          "[background-image:linear-gradient(currentColor,currentColor)]",
          "[background-size:var(--media-volume-fill,0%)_100%] transition-[background-size] duration-media-slow ease-linear",
        )}
      >
        <VolumeHighIconPrimitive
          className={
            "hidden shrink-0 group-data-[level=high]/volume-status:block mix-blend-difference"
          }
        />
        <VolumeLowIconPrimitive
          className={
            "hidden shrink-0 group-data-[level=low]/volume-status:block mix-blend-difference"
          }
        />
        <VolumeOffIconPrimitive
          className={
            "hidden shrink-0 group-data-[level=off]/volume-status:block mix-blend-difference"
          }
        />
        <VolumeIndicatorPrimitive.Value className={"ml-auto mix-blend-difference"} />
      </VolumeIndicatorPrimitive.Fill>
    </VolumeIndicatorPrimitive.Root>
  );
}
