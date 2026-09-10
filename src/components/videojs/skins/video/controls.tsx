import { Controls, Time } from "@videojs/react";

import { AirPlayButton } from "@/components/videojs/ui/airplay-button";
import { ButtonTooltip } from "@/components/videojs/ui/button-tooltip";
import { CaptionsButton } from "@/components/videojs/ui/captions-button";
import { CastButton } from "@/components/videojs/ui/cast-button";
import { FullscreenButton } from "@/components/videojs/ui/fullscreen-button";
import { PiPButton } from "@/components/videojs/ui/pip-button";
import { PlayButton } from "@/components/videojs/ui/play-button";
import { TimeSlider } from "@/components/videojs/ui/time-slider";
import { VolumePopover } from "@/components/videojs/ui/volume-popover";
import {
  ControlsSurface,
  type SkinControlsProps,
} from "@/components/videojs/skins/shared/controls-surface";

import { VideoSettingsMenu } from "./settings-menu";

/** 点播控制行：进度条独占一行，按钮行与直播保持同一套原生控件与顺序。 */
export function DefaultVideoControls({
  chrome,
  avoidSystemGestureBar,
  pictureInPictureDisabled,
  showVolumeControl = true,
  showFullscreenButton = true,
  children,
}: SkinControlsProps = {}) {
  return (
    <ControlsSurface chrome={chrome} avoidSystemGestureBar={avoidSystemGestureBar}>
      <Controls.Group className="flex w-full min-w-0 items-center gap-2 px-1">
        <Time.Value className="shrink-0 text-media-sm tabular-nums" type="current" />
        <TimeSlider />
        <Time.Value className="shrink-0 text-media-sm tabular-nums" type="remaining" toggle />
      </Controls.Group>
      <Controls.Group className="flex w-full min-w-0 items-center gap-px">
        <Controls.Group className="flex shrink-0 items-center gap-px">
          <ButtonTooltip side="top">
            <PlayButton />
          </ButtonTooltip>
          {showVolumeControl && <VolumePopover />}
        </Controls.Group>
        {children}
        <Controls.Group className="ms-auto flex shrink-0 items-center gap-px">
          <CaptionsButton className="media-max-lg:hidden" />
          <VideoSettingsMenu />
          <ButtonTooltip side="top">
            <CastButton className="media-max-sm:hidden" />
          </ButtonTooltip>
          <ButtonTooltip side="top">
            <AirPlayButton className="media-max-sm:hidden" />
          </ButtonTooltip>
          <ButtonTooltip side="top">
            <PiPButton className="media-max-xs:hidden" disabled={pictureInPictureDisabled} />
          </ButtonTooltip>
          {showFullscreenButton && (
            <ButtonTooltip side="top">
              <FullscreenButton />
            </ButtonTooltip>
          )}
        </Controls.Group>
      </Controls.Group>
    </ControlsSurface>
  );
}
