// VOD 保留既有入口，共用实现位于 shared，供直播、IPTV 和本地回放复用。
import type {
  PlayerExitQuiet,
  QuietableDanmakuRenderer,
} from "@/shared/player/playerExitQuiet";
import type { PlaybackClock } from "./videoPlaybackClock";

export type VideoExitQuiet = PlayerExitQuiet & {
  clock: PlaybackClock;
  danmakuRendererRef: { current: QuietableDanmakuRenderer | null };
};

export {
  disposePlayerExitQuiet as disposeVideoExitQuiet,
  hasQuietPlayerForExit as hasQuietVideoPlayerForExit,
  quietPlayerForExit as quietVideoPlayerForExit,
  releasePlayerExitQuiet as releaseVideoExitQuiet,
  type QuietableDanmakuRenderer,
} from "@/shared/player/playerExitQuiet";
