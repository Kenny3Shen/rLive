/**
 * 请求播放但不占用代理生命周期队列；isCurrent 也应在用户暂停后返回 false。
 * 仅策略阻拦会静音降级，降级后保持静音，等待用户主动恢复声音。
 */
export function requestPlayerAutoplay(
  player: { play: () => Promise<void> | null },
  video: Pick<HTMLVideoElement, "muted">,
  isCurrent: () => boolean,
  onAutoplayMuted?: () => void,
  onAutoplayStarted?: () => void,
): void {
  void (async () => {
    let retriedAbort = false;
    let retriedMuted = false;
    while (isCurrent()) {
      try {
        await player.play();
      } catch (error) {
        if (!isCurrent()) return;
        const name =
          typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
        if (name === "AbortError" && !retriedAbort) {
          // 适配器初始化时的 load 可能中断播放，只允许按当前音量重试一次。
          retriedAbort = true;
          continue;
        }
        if (name === "NotAllowedError" && !video.muted && !retriedMuted) {
          retriedMuted = true;
          video.muted = true;
          if (!isCurrent()) return;
          onAutoplayMuted?.();
          continue;
        }
        // 网络、解码等媒体故障交给已有的播放器错误事件，不以静音掩盖。
        return;
      }
      if (isCurrent()) onAutoplayStarted?.();
      return;
    }
  })();
}
