import { createPlayer } from "@videojs/react";
import { metadataFeature, playbackFeature } from "@videojs/core/dom";

/**
 * 短视频封面用的最小播放器 store。
 *
 * `Poster` 读的是播放器 store：`playback.started` 决定封面该不该盖着（一旦开播或
 *  seek 过就藏起来，换源时重新盖回），`metadata.poster` 是它的兜底图源。短视频
 *  不走 Video.js 的媒体适配器（传输是自有的 `VideoJsPlayer` + dash.js），这里挂
 *  store 只为让 `Poster` 能读到 `<video>` 的播放状态。
 *
 * 只带这两个 feature 而不是整套 `videoFeatures`：剩下的（画质、音轨、全屏、PiP、
 * 字幕、直播边沿……）竖屏舞台一条都用不上，而每个 feature 都会在 attach 时往媒体
 * 元素上挂一组监听 —— 三个槽位各一份，白付三倍。
 */
export const ShortsPosterPlayer = createPlayer({
  features: [playbackFeature, metadataFeature],
  displayName: "rLiveShortsPoster",
}).Player;
