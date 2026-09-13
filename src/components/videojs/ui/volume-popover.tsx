import "../styles/theme.css";
import type { VolumeSliderProps as CoreVolumeSliderProps } from "@videojs/core";
import { VolumePopover as VolumePopoverPrimitive } from "@videojs/react";
import type { ClassValue } from "cn";

import { cn } from "@/components/videojs/lib/resolve-class-name";
import {
  mediaPopupMotionClass,
  mediaPopupResetClass,
  mediaPopupSurfaceClass,
} from "@/components/videojs/lib/popup-surface";
import { ButtonTooltip } from "@/components/videojs/ui/button-tooltip";
import { MuteButton } from "@/components/videojs/ui/mute-button";
import { VolumeSlider } from "@/components/videojs/ui/volume-slider";

export interface VolumePopoverProps extends Omit<VolumePopoverPrimitive.RootProps, "children"> {
  className?: ClassValue;
  orientation?: CoreVolumeSliderProps["orientation"];
  showTooltip?: boolean;
}

export function VolumePopover({
  className,
  showTooltip = false,
  side = "top",
  orientation = "vertical",
  ...props
}: VolumePopoverProps = {}) {
  return (
    <VolumePopoverPrimitive.Root openOnHover delay={200} closeDelay={100} side={side} {...props}>
      <ButtonTooltip delay={0} disabled={!showTooltip} sticky side="top">
        <VolumePopoverPrimitive.Trigger render={<MuteButton className={cn(className)} />} />
      </ButtonTooltip>
      <VolumePopoverPrimitive.Popup
        className={cn(
          mediaPopupResetClass,
          mediaPopupMotionClass,
          mediaPopupSurfaceClass,
          "rounded-media-control px-0 py-3 [--media-popup-side-offset:var(--media-popover-side-offset)]",
          "data-[side=right]:rounded-none data-[side=right]:p-0 data-[side=right]:px-3 data-[side=right]:surface-media-none! data-[side=right]:after:hidden",
          "data-[side=right]:[--media-popover-side-offset:0rem]",
        )}
      >
        <VolumeSlider orientation={orientation} />
      </VolumePopoverPrimitive.Popup>
    </VolumePopoverPrimitive.Root>
  );
}
