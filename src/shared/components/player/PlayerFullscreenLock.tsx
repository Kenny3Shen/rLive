import { Lock, Unlock } from "lucide-react";
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent, Ref } from "react";
import { Button } from "@/components/ui/button";
import {
  PLAYER_CONTROL_BUTTON_CLASS,
  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { cn } from "@/lib/utils";

// 全屏锁定在桌面与移动端都可用：移动端主要防触摸手势误触，桌面端则可同时
// 收起并冻结播放器 chrome。窗口化时不挂载，避免把锁定状态带回普通播放器。
export function showPlayerFullscreenLock(fullscreen: boolean): boolean {
  return fullscreen;
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
 * 全屏的交互锁按钮层。
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
      className="absolute top-1/2 left-[max(16px,env(safe-area-inset-left))] z-40 -translate-y-1/2 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
      onPointerEnter={onPointerEnter}
      onPointerDown={onPointerDown}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={locked ? "解锁全屏操作" : "锁定全屏操作"}
        aria-pressed={locked}
        className={cn(
          PLAYER_CONTROL_BUTTON_CLASS,
          PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
          // 流媒体全屏里的独立浮动操作要比控制栏按钮更醒目：桌面保持 48px，
          // 粗指针设备提升到 56px，均高于 WCAG 44px 触控下限。固定 px 避免应用
          // 根字号缩放把 rem 命中框压回 40px 左右；图标按两档同比放大但保留留白。
          "size-[48px] rounded-full border border-white/15 bg-black/55 shadow-lg backdrop-blur-sm [@media(pointer:coarse)]:size-[56px] hover:bg-black/70",
          locked && "bg-black/75",
        )}
        onClick={onToggle}
      >
        {locked ? (
          <Lock className="size-[28px] [@media(pointer:coarse)]:size-[30px]" />
        ) : (
          <Unlock className="size-[28px] [@media(pointer:coarse)]:size-[30px]" />
        )}
      </Button>
    </div>
  );
}
