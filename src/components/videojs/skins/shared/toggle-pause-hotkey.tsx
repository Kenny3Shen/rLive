import { Hotkey, useHotkey } from "@videojs/react";

/**
 * 业务接管 Space/K 暂停时的注册参数。
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

/**
 * Space/K 的播放暂停快捷键。传入 `onTogglePause` 时走业务入口（键盘暂停与
 * 播放按钮共用同一条记账），否则保留 Video.js 原生 `togglePaused` 动作。
 */
export function TogglePauseHotkey({
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
