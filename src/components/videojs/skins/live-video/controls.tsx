import { Controls } from "@videojs/react";

import { AirPlayButton } from "@/components/videojs/ui/airplay-button";
import { ButtonTooltip } from "@/components/videojs/ui/button-tooltip";
import { CaptionsMenu } from "@/components/videojs/ui/captions-menu";
import { CastButton } from "@/components/videojs/ui/cast-button";
import { FullscreenButton } from "@/components/videojs/ui/fullscreen-button";
import { LiveButton } from "@/components/videojs/ui/live-button";
import { PiPButton } from "@/components/videojs/ui/pip-button";
import { PlayButton } from "@/components/videojs/ui/play-button";
import { VolumePopover } from "@/components/videojs/ui/volume-popover";
import {
  ControlsSurface,
  type SkinControlsProps,
} from "@/components/videojs/skins/shared/controls-surface";

/** 直播控制行：播放/直播边缘/音量在左，投屏与全屏在右，业务控件占据中间。 */
export function DefaultLiveVideoControls({
  chrome,
  avoidSystemGestureBar,
  pictureInPictureDisabled,
  showVolumeControl = true,
  showFullscreenButton = true,
  children,
}: SkinControlsProps = {}) {
  return (
    <ControlsSurface chrome={chrome} avoidSystemGestureBar={avoidSystemGestureBar}>
      <Controls.Group className="flex w-full min-w-0 items-center gap-px">
        <Controls.Group className="flex shrink-0 items-center gap-px">
          <ButtonTooltip side="top">
            <PlayButton />
          </ButtonTooltip>
          <LiveButton />
          {showVolumeControl && <VolumePopover />}
        </Controls.Group>
        {children}
        <Controls.Group className="ms-auto flex shrink-0 items-center gap-px">
          <CaptionsMenu className="media-max-lg:hidden" />
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
