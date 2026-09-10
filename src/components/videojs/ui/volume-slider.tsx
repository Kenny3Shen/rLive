import "../styles/theme.css";
import { VolumeSlider as VolumeSliderPrimitive } from "@videojs/react";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { SliderFill, SliderThumb, SliderTrack } from "@/components/videojs/ui/slider";

export type VolumeSliderProps = Omit<VolumeSliderPrimitive.RootProps, "children">;

export function VolumeSlider({ className, ...props }: VolumeSliderProps = {}) {
  return (
    <VolumeSliderPrimitive.Root
      className={(state) =>
        cn(
          "group/slider relative flex flex-1 cursor-pointer items-center justify-center outline-hidden",
          "data-disabled:pointer-events-none",
          "rounded-media-pill",
          "data-[orientation=horizontal]:[height:var(--media-slider-height,--spacing(8))]",
          "data-[orientation=vertical]:w-8 data-[orientation=vertical]:min-w-0",
          "data-[orientation=horizontal]:min-w-18 data-[orientation=vertical]:h-18",
          "media-volume-slider",
          resolveClassName(className, state),
        )
      }
      thumbAlignment="edge"
      {...props}
    >
      <VolumeSliderPrimitive.Track render={<SliderTrack />}>
        <VolumeSliderPrimitive.Fill render={<SliderFill />} />
      </VolumeSliderPrimitive.Track>
      <VolumeSliderPrimitive.Thumb render={<SliderThumb />} className={"scale-100 opacity-100"} />
    </VolumeSliderPrimitive.Root>
  );
}
