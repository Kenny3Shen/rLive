import { Lock, Unlock } from "lucide-react";
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent, Ref } from "react";
import { Button } from "@/components/ui/button";
import {
  PLAYER_CONTROL_BUTTON_CLASS,
  PLAYER_CONTROL_ICON_CLASS,
  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { cn } from "@/lib/utils";

/**
 * 全屏锁定只在移动端全屏出现：它要挡掉的正是单击/双击/边缘滑动这套触摸手势，
 * 桌面端没有误触问题，窗口化时也随时可以直接离开。
 */
export function showPlayerFullscreenLock(mobileClient: boolean, fullscreen: boolean): boolean {
  return mobileClient && fullscreen;
}

/**
 * 锁定期间画面手势全部让位给锁定按钮本身，否则用户既解不开锁、
 * 又会继续误触发音量和全屏。
 */
export function playerStageGesturesEnabled(fullscreenLocked: boolean): boolean {
  return !fullscreenLocked;
}

/**
 * 锁定期间两层 chrome 始终保持收起：画面手势已全部屏蔽，控制条露出来也无从操作。
 * 空闲唤醒态因此只作用于锁定按钮那一层。
 */
export function playerChromeVisible(visible: boolean, fullscreenLocked: boolean): boolean {
  return visible && !fullscreenLocked;
}

/**
 * 移动端全屏的手势锁按钮层。
 *
 * 它是画面 chrome 的兄弟层，与两层 chrome 共享同一个空闲计时器 —— 锁定期间也会
 * 休眠淡出，随后由舞台点按唤回（否则用户会被困在锁定的全屏里）。`visible` 只提供
 * 与命令式写入一致的渲染值：真正的显隐由宿主写 `data-visible`。
 */
export function PlayerFullscreenLock({
  ref,
  visible,
  locked,
  onToggle,
  onPointerEnter,
  onPointerDown,
  onPointerLeave,
  onFocusCapture,
  onBlurCapture,
}: {
  ref: Ref<HTMLDivElement>;
  visible: boolean;
  locked: boolean;
  onToggle: () => void;
  onPointerEnter?: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: () => void;
  onFocusCapture?: () => void;
  onBlurCapture?: (event: ReactFocusEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      ref={ref}
      data-player-fullscreen-lock
      data-visible={visible ? "true" : "false"}
      aria-hidden={!visible}
      className="absolute top-1/2 left-[max(0.5rem,env(safe-area-inset-left))] z-40 -translate-y-1/2 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
      onPointerEnter={onPointerEnter}
      onPointerDown={onPointerDown}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={locked ? "解锁全屏手势" : "锁定全屏手势"}
        aria-pressed={locked}
        className={cn(
          PLAYER_CONTROL_BUTTON_CLASS,
          PLAYER_CONTROL_ICON_CLASS,
          PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
          "bg-black/40 hover:bg-black/55",
          locked && "bg-black/60",
        )}
        onClick={onToggle}
      >
        {locked ? <Lock /> : <Unlock />}
      </Button>
    </div>
  );
}
