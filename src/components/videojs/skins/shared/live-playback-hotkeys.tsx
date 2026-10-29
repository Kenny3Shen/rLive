import { Hotkey, useHotkey } from "@videojs/react";

export interface LivePlaybackHotkeysProps {
  disabled?: boolean | undefined;
  /**
   * 由业务播放器接管 Space/K 的播放暂停。传入后与播放按钮走同一条
   * `useWebPlayer.togglePause()`，键盘暂停同样写入 `userPausedRef`；
   * 不传时保留 Video.js 原生动作。
   */
  onTogglePause?: (() => void) | undefined;
}

/**
 * 业务接管暂停时的注册参数。
 *
 * 仍以 `action: "togglePaused"` 注册：状态提示与「切换类快捷键不重复触发」
 * 都由这个 action 名决定，只把激活动作换成业务入口。输入框、菜单、滑块与
 * 按钮内的 Space 仍由协调器原有的交互目标判定过滤，语义不变。
 */
export function businessTogglePauseHotkeyOptions(
  onTogglePause: () => void,
  keys: string,
  disabled = false,
) {
  return {
    keys,
    action: "togglePaused" as const,
    disabled,
    onActivate: () => onTogglePause(),
  };
}

function BusinessTogglePauseHotkey({
  keys,
  disabled,
  onTogglePause,
}: {
  keys: string;
  disabled: boolean;
  onTogglePause: () => void;
}) {
  useHotkey(businessTogglePauseHotkeyOptions(onTogglePause, keys, disabled));
  return null;
}

function TogglePauseHotkey({
  keys,
  disabled,
  onTogglePause,
}: {
  keys: string;
  disabled: boolean;
  onTogglePause?: (() => void) | undefined;
}) {
  if (onTogglePause) {
    return (
      <BusinessTogglePauseHotkey keys={keys} disabled={disabled} onTogglePause={onTogglePause} />
    );
  }
  return <Hotkey disabled={disabled} keys={keys} action="togglePaused" />;
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
