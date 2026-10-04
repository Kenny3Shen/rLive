import { createPlayer } from "@videojs/react";
import { metadataFeature, playbackFeature } from "@videojs/core/dom";

/**
 * 短视频舞台状态指示用的最小播放器 store。
 *
 * 短视频不走 Video.js 的媒体适配器（传输是自有的 `VideoJsPlayer` + dash.js），
 * 这里让 `BufferingIndicator` / `PlayButton` 读取 `<video>` 的播放状态。
 * 舞台不渲染 `Poster`：画面的唯一来源就是已解码的视频帧，加载期间是黑屏加转圈
 * （见 `ShortsStage`）。
 *
 * 只带这两个 feature 而不是整套 `videoFeatures`：剩下的（画质、音轨、全屏、PiP、
 * 字幕、直播边沿……）竖屏舞台一条都用不上，而每个 feature 都会在 attach 时往媒体
 * 元素上挂一组监听 —— 三个槽位各一份，白付三倍。
 */
export const ShortsStagePlayer = createPlayer({
  features: [playbackFeature, metadataFeature],
  displayName: "rLiveShortsStage",
}).Player;
