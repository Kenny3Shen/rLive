import { Hotkey } from "@videojs/react";

import { TogglePauseHotkey } from "./toggle-pause-hotkey";

export interface PlaybackHotkeysProps {
  disabled?: boolean | undefined;
  /**
   * 由业务播放器接管 Space/K 的播放暂停。传入后激活动作走业务入口（点播为
   * `togglePlayback`），与页面手势共用同一份暂停意图记账；不传时保留
   * Video.js 原生动作。
   */
  onTogglePause?: (() => void) | undefined;
}

export function PlaybackHotkeys({ disabled = false, onTogglePause }: PlaybackHotkeysProps = {}) {
  return (
    <>
      <TogglePauseHotkey keys="Space" disabled={disabled} onTogglePause={onTogglePause} />
      <TogglePauseHotkey keys="k" disabled={disabled} onTogglePause={onTogglePause} />
      <Hotkey disabled={disabled} keys="m" action="toggleMuted" />
      <Hotkey disabled={disabled} keys="ArrowRight" action="seekStep" />
      <Hotkey disabled={disabled} keys="ArrowLeft" action="seekStep" />
      <Hotkey disabled={disabled} keys="l" action="seekStep" />
      <Hotkey disabled={disabled} keys="j" action="seekStep" />
      <Hotkey disabled={disabled} keys="ArrowUp" action="volumeStep" />
      <Hotkey disabled={disabled} keys="ArrowDown" action="volumeStep" />
      <Hotkey disabled={disabled} keys="0-9" action="seekToPercent" />
      <Hotkey disabled={disabled} keys="Home" action="seekToPercent" value={0} />
      <Hotkey disabled={disabled} keys="End" action="seekToPercent" value={100} />
      <Hotkey disabled={disabled} keys=">" action="speedUp" />
      <Hotkey disabled={disabled} keys="<" action="speedDown" />
    </>
  );
}
