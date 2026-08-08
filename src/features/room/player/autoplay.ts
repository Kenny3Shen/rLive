function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/**
 * Request playback without holding the proxy lifecycle queue open. Some
 * WebViews reject an unmuted request after route navigation, so retry once
 * muted and restore audio after playback has started.
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
        // The player error event reports the actionable playback failure.
      }
    }
  })();
}
