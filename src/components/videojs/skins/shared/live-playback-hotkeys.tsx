import { Hotkey } from "@videojs/react";

import { TogglePauseHotkey } from "./toggle-pause-hotkey";

export interface LivePlaybackHotkeysProps {
  disabled?: boolean | undefined;
  /**
   * 由业务播放器接管 Space/K 的播放暂停。传入后与播放按钮走同一条
   * `useWebPlayer.togglePause()`，键盘暂停同样写入 `userPausedRef`；
   * 不传时保留 Video.js 原生动作。
   */
  onTogglePause?: (() => void) | undefined;
}

export function LivePlaybackHotkeys({
  disabled = false,
  onTogglePause,
}: LivePlaybackHotkeysProps = {}) {
  return (
    <>
      <TogglePauseHotkey keys="Space" disabled={disabled} onTogglePause={onTogglePause} />
      <TogglePauseHotkey keys="k" disabled={disabled} onTogglePause={onTogglePause} />
      <Hotkey disabled={disabled} keys="m" action="toggleMuted" />
      <Hotkey disabled={disabled} keys="ArrowUp" action="volumeStep" />
      <Hotkey disabled={disabled} keys="ArrowDown" action="volumeStep" />
    </>
  );
}
