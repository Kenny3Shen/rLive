import {
  PlayerSkinSurface,
  type PlayerSkinProps,
} from "@/components/videojs/skins/shared/skin-surface";

import { VideoHotkeys } from "./hotkeys";
import { VideoStatusIndicators } from "./status-indicators";

export type MinimalVideoSkinProps = PlayerSkinProps;

/** 点播极简皮肤：方形控制键、更窄阴影与更靠上的字幕/进度预览。 */
export function MinimalVideoSkin(props: MinimalVideoSkinProps = {}) {
  return (
    <PlayerSkinSurface
      theme="minimal"
      preset="video"
      variant="vod"
      hotkeys={<VideoHotkeys />}
      statusIndicators={<VideoStatusIndicators />}
      {...props}
    />
  );
}
