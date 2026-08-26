function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/**
 * 请求播放但不让代理生命周期队列被占住。部分 WebView 会在路由导航后拒绝非静音
 * 请求，因此静音重试一次，播放开始后再恢复声音。
 */
export function requestPlayerAutoplay(
  player: { play: () => Promise<void> | null },
  video: Pick<HTMLVideoElement, "muted">,
  isCurrent: () => boolean,
  onMutedAutoplayRecovered: () => boolean | void,
  onAutoplayStarted?: () => void,
): void {
  void (async () => {
    try {
      await player.play();
      if (isCurrent()) onAutoplayStarted?.();
      return;
    } catch {
      if (!isCurrent()) return;
      video.muted = true;
      try {
        await player.play();
        await sleep(80);
        if (!isCurrent()) return;
        const shouldRestoreAudio = onMutedAutoplayRecovered() !== false;
        if (shouldRestoreAudio) video.muted = false;
        onAutoplayStarted?.();
      } catch {
        // 播放器错误事件上报可操作的播放失败信息。
      }
    }
  })();
}
