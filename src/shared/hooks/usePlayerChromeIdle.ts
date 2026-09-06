import { useCallback, useEffect, useRef, type RefObject } from "react";

/** 空闲多久后把 chrome 淡出。 */
const CHROME_IDLE_DELAY_MS = 2_600;

/**
 * 播放器 chrome 的空闲隐藏：底部控制条与顶部 HUD 共享一个倒计时，写
 * `data-visible` / `aria-hidden`（淡出动画由 CSS 的 `data-[visible=false]`
 * 完成）。暂停、缓冲、失败或弹层打开时不排隐藏；键盘焦点落在 chrome 里
 * （弹幕输入框正在输入、焦点停在控制按钮上）时同样不隐藏，否则输入过程中
 * 指针划过画面就会让输入框带着未发送的草稿一起淡出。
 */
export function usePlayerChromeIdle({
  controlsRef,
  hudRef,
  keepVisible,
}: {
  /** 底部控制条宿主元素。 */
  controlsRef: RefObject<HTMLElement | null>;
  /** 顶部 HUD 宿主元素。 */
  hudRef: RefObject<HTMLElement | null>;
  /** true 时不参与空闲隐藏（暂停、缓冲、失败、弹层打开）。 */
  keepVisible: boolean;
}) {
  const hideTimerRef = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const setChromeVisible = useCallback(
    (visible: boolean) => {
      for (const layer of [controlsRef.current, hudRef.current]) {
        if (!layer) continue;
        layer.dataset.visible = visible ? "true" : "false";
        layer.setAttribute("aria-hidden", String(!visible));
      }
    },
    [controlsRef, hudRef],
  );

  const hasKeyboardFocusWithinChrome = useCallback(() => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !activeElement.matches(":focus-visible")) {
      return false;
    }
    return (
      controlsRef.current?.contains(activeElement) === true ||
      hudRef.current?.contains(activeElement) === true
    );
  }, [controlsRef, hudRef]);

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

  const revealControls = useCallback(() => {
    setChromeVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide, setChromeVisible]);

  const holdControlsVisible = useCallback(() => {
    clearHideTimer();
    setChromeVisible(true);
  }, [clearHideTimer, setChromeVisible]);

  // 卸载时不留下悬空的隐藏定时器。
  useEffect(() => clearHideTimer, [clearHideTimer]);

  return { revealControls, holdControlsVisible, scheduleControlsHide };
}
