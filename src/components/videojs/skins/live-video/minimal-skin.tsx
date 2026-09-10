import {
  PlayerSkinSurface,
  type PlayerSkinProps,
} from "@/components/videojs/skins/shared/skin-surface";

import { LiveVideoHotkeys } from "./hotkeys";
import { LiveVideoStatusIndicators } from "./status-indicators";

export type MinimalLiveVideoSkinProps = PlayerSkinProps;

/** 直播极简皮肤：方形控制键、更窄阴影与更靠上的字幕/进度预览。 */
export function MinimalLiveVideoSkin(props: MinimalLiveVideoSkinProps = {}) {
  return (
    <PlayerSkinSurface
      theme="minimal"
      preset="live-video"
      variant="live"
      hotkeys={<LiveVideoHotkeys />}
      statusIndicators={<LiveVideoStatusIndicators />}
      {...props}
    />
  );
}
