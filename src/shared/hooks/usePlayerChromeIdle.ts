import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { playerChromeVisible } from "@/shared/components/player/PlayerFullscreenLock";
import {
  applyPlayerChromeVisibility,
  usePlayerChromeVisibility,
} from "./usePlayerChromeVisibility";

/** 空闲多久后把 chrome 淡出。 */
const CHROME_IDLE_DELAY_MS = 2_000;

/**
 * 播放器 chrome 的空闲隐藏：底部控制条与顶部 HUD 共享一个倒计时，写
 * `data-visible` / `aria-hidden`（淡出动画由 CSS 的 `data-[visible=false]`
 * 完成）。暂停、缓冲、失败或弹层打开时不排隐藏；键盘焦点落在 chrome 里
 * （弹幕输入框正在输入、焦点停在控制按钮上）时同样不隐藏，否则输入过程中
 * 指针划过画面就会让输入框带着未发送的草稿一起淡出。
 *
 * 鼠标离开播放器区域不等空闲倒计时，走 `dismissControls` 立即收起，
 * 守卫与空闲隐藏完全一致。
 */
export function usePlayerChromeIdle({
  controlsRef,
  hudRef,
  lockRef,
  fullscreenLocked,
  keepVisible,
}: {
  /** 底部控制条宿主元素。 */
  controlsRef: RefObject<HTMLElement | null>;
  /** 顶部 HUD 宿主元素。 */
  hudRef: RefObject<HTMLElement | null>;
  /** 锁定按钮跟随唤醒态，锁定期间上下控制层始终隐藏。 */
  lockRef: RefObject<HTMLElement | null>;
  fullscreenLocked: boolean;
  /** true 时不参与空闲隐藏（暂停、缓冲、失败、弹层打开）。 */
  keepVisible: boolean;
}) {
  const hideTimerRef = useRef<number | null>(null);
  const controlsVisibleRef = useRef(true);
  usePlayerChromeVisibility({
    controlsRef,
    hudRef,
    visibleRef: controlsVisibleRef,
    lockRef,
    locked: fullscreenLocked,
  });

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const setChromeVisible = useCallback(
    (visible: boolean) => {
      controlsVisibleRef.current = visible;
      const chromeVisible = playerChromeVisible(visible, fullscreenLocked);
      applyPlayerChromeVisibility([controlsRef.current, hudRef.current], chromeVisible);
      applyPlayerChromeVisibility([lockRef.current], visible);
    },
    [controlsRef, fullscreenLocked, hudRef, lockRef],
  );

  const hasKeyboardFocusWithinChrome = useCallback(() => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !activeElement.matches(":focus-visible")) {
      return false;
    }
    return (
      controlsRef.current?.contains(activeElement) === true ||
      hudRef.current?.contains(activeElement) === true ||
      lockRef.current?.contains(activeElement) === true
    );
  }, [controlsRef, hudRef, lockRef]);

  const scheduleControlsHide = useCallback(() => {
    clearHideTimer();
    if (keepVisible || hasKeyboardFocusWithinChrome()) {
      setChromeVisible(true);
      return;
    }
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      // 定时器排定之后焦点才进入 chrome（点进弹幕输入框开始打字），
      // 触发时再核一次，别把正在输入的输入框淡出去。
      if (hasKeyboardFocusWithinChrome()) {
        setChromeVisible(true);
        return;
      }
      setChromeVisible(false);
    }, CHROME_IDLE_DELAY_MS);
  }, [clearHideTimer, hasKeyboardFocusWithinChrome, keepVisible, setChromeVisible]);

  /**
   * 立即收起 chrome：指针已离开播放器区域时不再等待空闲倒计时。
   * 守卫与 `scheduleControlsHide` 相同（暂停、缓冲、失败、弹层打开或
   * 键盘焦点在 chrome 里时保持可见），保证退出路径与空闲路径的可见性
   * 契约不因触发方式不同而分叉。
   */
  const dismissControls = useCallback(() => {
    clearHideTimer();
    if (keepVisible || hasKeyboardFocusWithinChrome()) {
      setChromeVisible(true);
      return;
    }
    setChromeVisible(false);
  }, [clearHideTimer, hasKeyboardFocusWithinChrome, keepVisible, setChromeVisible]);

  const revealControls = useCallback(() => {
    setChromeVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide, setChromeVisible]);

  /**
   * 按用户明确意图收起 chrome（点画面），不同于 `dismissControls` 的被动退出。
   *
   * 刻意越过 `keepVisible`：暂停、缓冲、失败都会把它置为 true，而那几种状态正是
   * chrome 最可能正显示、用户最想把它收掉的时候；沿用被动守卫会让「再点一下收起」
   * 恰好在最常见的场景里失效。
   *
   * 键盘焦点的守卫保留：`applyPlayerChromeVisibility` 会写 `aria-hidden`，把焦点
   * 留在隐藏子树里是无障碍缺陷。该守卫只在 `:focus-visible`（键盘导航）时成立，
   * 触摸点按不会命中，因此不影响移动端手势。
   */
  const hideControls = useCallback(() => {
    clearHideTimer();
    if (hasKeyboardFocusWithinChrome()) {
      setChromeVisible(true);
      return;
    }
    setChromeVisible(false);
  }, [clearHideTimer, hasKeyboardFocusWithinChrome, setChromeVisible]);

  /** 单击语义：隐藏时唤出，已可见时收起。 */
  const toggleControls = useCallback(() => {
    if (controlsVisibleRef.current) {
      hideControls();
      return;
    }
    revealControls();
  }, [hideControls, revealControls]);

  const holdControlsVisible = useCallback(() => {
    clearHideTimer();
    setChromeVisible(true);
  }, [clearHideTimer, setChromeVisible]);

  // 锁定、解锁与暂停/缓冲状态改变时同步三层，不能等下一次指针事件。
  useLayoutEffect(() => {
    revealControls();
  }, [revealControls]);

  // 卸载时不留下悬空的隐藏定时器。
  useEffect(() => clearHideTimer, [clearHideTimer]);

  return {
    controlsVisibleRef,
    revealControls,
    hideControls,
    toggleControls,
    holdControlsVisible,
    scheduleControlsHide,
    dismissControls,
  };
}
