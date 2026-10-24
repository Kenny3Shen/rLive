export type HlsMediaProgressSource = Pick<
  HTMLMediaElement,
  "paused" | "readyState" | "seeking" | "currentTime"
> & {
  addEventListener(
    type: "timeupdate" | "seeking" | "waiting" | "pause",
    listener: () => void,
  ): void;
  removeEventListener(
    type: "timeupdate" | "seeking" | "waiting" | "pause",
    listener: () => void,
  ): void;
};

/**
 * 用真实媒体时间推进 HLS 稳定计时。
 *
 * 某些 network fatal 后缓冲仍能继续播放，hls.js 恢复时浏览器不会再发
 * `playing`。因此 timeupdate 只有在未暂停、已有当前帧、未寻址且 currentTime
 * 确实前进时才通知调用方；暂停、缓冲或一次 seek 都不能伪装成稳定播放。
 * 这是事件监听而非 React 状态，不触发重渲染。
 */
export function watchHlsMediaProgress(
  media: HlsMediaProgressSource,
  onProgress: () => void,
  onPlaybackInterrupted: () => void,
  isCurrent: () => boolean = () => true,
): () => void {
  let lastCurrentTime = media.currentTime;
  // seek 会把 currentTime 直接跳到目标位置。下一次合格 timeupdate 只重对齐
  // 基线，不能把跳变本身当成连续播放进展。
  let rebaselineOnTimeUpdate = false;

  const onTimeUpdate = () => {
    if (!isCurrent()) return;
    const currentTime = media.currentTime;
    // 媒体尚未就绪时 currentTime 可能是 NaN；不要用它污染后续比较基线。
    if (!Number.isFinite(currentTime)) return;
    const advanced = currentTime > lastCurrentTime;
    lastCurrentTime = currentTime;
    // 打断只由真实的 waiting/pause/seeking 事件表达；这些状态下仍更新基线，
    // 但保留 seek 的重对齐标记，等首个可播放的 timeupdate 再消费。
    if (media.paused || media.readyState < 2 || media.seeking) return;
    if (rebaselineOnTimeUpdate) {
      rebaselineOnTimeUpdate = false;
      return;
    }
    if (advanced) onProgress();
  };
  const onSeeking = () => {
    if (!isCurrent()) return;
    rebaselineOnTimeUpdate = true;
    onPlaybackInterrupted();
  };
  const onInterrupted = () => {
    if (isCurrent()) onPlaybackInterrupted();
  };

  media.addEventListener("timeupdate", onTimeUpdate);
  media.addEventListener("seeking", onSeeking);
  media.addEventListener("waiting", onInterrupted);
  media.addEventListener("pause", onInterrupted);
  return () => {
    media.removeEventListener("timeupdate", onTimeUpdate);
    media.removeEventListener("seeking", onSeeking);
    media.removeEventListener("waiting", onInterrupted);
    media.removeEventListener("pause", onInterrupted);
  };
}
