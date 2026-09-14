import "../styles/theme.css";
import type { VolumeSliderProps as CoreVolumeSliderProps } from "@videojs/core";
import { VolumePopover as VolumePopoverPrimitive } from "@videojs/react";
import type { ClassValue } from "cn";

import { cn } from "@/components/videojs/lib/resolve-class-name";
import {
  mediaPopupMotionClass,
  mediaPopupResetClass,
  mediaPopupTriggerOpenClass,
} from "@/components/videojs/lib/popup-surface";
import { ButtonTooltip } from "@/components/videojs/ui/button-tooltip";
import { MuteButton } from "@/components/videojs/ui/mute-button";
import { VolumeSlider } from "@/components/videojs/ui/volume-slider";
// 皮肤层唯一的应用侧样式依赖：玻璃材质是仓库级的唯一事实来源，重复一份类串比这条
// 单向引用更糟。
import { glassPanelClass } from "@/shared/components/player/glassSurface";

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
        <VolumePopoverPrimitive.Trigger
          className={(state) => cn(state.open && mediaPopupTriggerOpenClass)}
          render={<MuteButton className={cn(className)} />}
        />
      </ButtonTooltip>
      {/*
        与控制栏的播放设置、字幕菜单同构：弹层元素只负责重置 UA `[popover]` 外观并
        铺指针桥接区，材质画在子元素上。`mediaPopupMotionClass` 的桥接区占用
        `::before`，而玻璃填充也在 `::before`，两者不能共用一个元素。
      */}
      <VolumePopoverPrimitive.Popup
        className={cn(
          mediaPopupResetClass,
          mediaPopupMotionClass,
          "group/volume bg-transparent p-0 [--media-popup-side-offset:var(--media-popover-side-offset)]",
          "data-[side=right]:[--media-popover-side-offset:0rem]",
        )}
      >
        <div
          className={cn(
            "rounded-media-control px-0 py-3",
            glassPanelClass({ overlay: true }),
            // 上方空间不够时 Video.js 会把弹层翻到右侧、与控制栏并排，此时表面由控制栏
            // 自己承担，弹层不再画材质（对齐原先 `surface-media-none` 的处理）。
            "group-data-[side=right]/volume:rounded-none group-data-[side=right]/volume:border-0",
            "group-data-[side=right]/volume:p-0 group-data-[side=right]/volume:px-3",
            "group-data-[side=right]/volume:shadow-none",
            "group-data-[side=right]/volume:before:hidden",
            "group-data-[side=right]/volume:[backdrop-filter:none]",
          )}
        >
          <VolumeSlider orientation={orientation} />
        </div>
      </VolumePopoverPrimitive.Popup>
    </VolumePopoverPrimitive.Root>
  );
}
