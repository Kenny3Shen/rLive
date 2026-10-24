/**
 * Video.js 的 PlayButton 会从 click、Enter 和 Space 各自调用内部播放动作；
 * `mergeProps` 链式执行事件处理器且内部动作不检查 `defaultPrevented`，因此
 * 业务接管暂停时必须替换这些处理器，而不是在 `onClick` 里 preventDefault 后
 * 再让原处理器执行。这里保持原生按钮的键盘语义：Enter 在 keydown 激活，
 * Space 在 keyup 激活。
 */
export type PlayButtonActivationEvent = {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  preventDefault: () => void;
  key?: string;
};

export function createPlayButtonActivation({
  disabled,
  onTogglePause,
}: {
  disabled: boolean;
  onTogglePause: () => void;
}) {
  const activate = () => {
    if (!disabled) onTogglePause();
  };

  return {
    onClick(event: PlayButtonActivationEvent) {
      event.preventDefault();
      activate();
    },
    onKeyDown(event: PlayButtonActivationEvent) {
      if (event.target !== event.currentTarget) return;
      if (disabled) {
        if (event.key !== "Tab") event.preventDefault();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        activate();
      } else if (event.key === " ") {
        // Space 的默认激活发生在 keyup；先阻止滚动，再由 keyup 调用一次。
        event.preventDefault();
      }
    },
    onKeyUp(event: PlayButtonActivationEvent) {
      if (event.target !== event.currentTarget || disabled) return;
      if (event.key === " ") {
        event.preventDefault();
        activate();
      }
    },
  };
}
