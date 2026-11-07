import { ChevronLeft } from "lucide-react";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { isMobileClient } from "@/shared/clientPlatform";
import { PLAYER_BACK_ONLY_SURFACE_CLASS } from "./playerBackGeometry";
import { PLAYER_HUD_BUTTON_CLASS, PLAYER_HUD_ICON_CLASS } from "./PlayerControls";

/** 取流期间不显示控制栏，但始终保留退出当前播放层的入口。 */
export function PlayerLoadingBackButton({
  onClick,
  label = "返回上一页",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <div
      data-player-loading-back
      data-density={isMobileClient() ? "dense" : undefined}
      className={PLAYER_BACK_ONLY_SURFACE_CLASS}
    >
      <MediaButton type="button" aria-label={label} className={PLAYER_HUD_BUTTON_CLASS} onClick={onClick}>
        <ChevronLeft className={PLAYER_HUD_ICON_CLASS} data-icon="inline-start" aria-hidden />
      </MediaButton>
    </div>
  );
}
