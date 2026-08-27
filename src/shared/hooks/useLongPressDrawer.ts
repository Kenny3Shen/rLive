import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
import { useLongPress } from "@/shared/hooks/useLongPress";

/**
 * 「长按卡片弹出底部操作抽屉」的公共接线。
 *
 * 封装长按检测、抽屉开关、Android Back 收起与触发后松手合成 click 的抑制，
 * 由直播卡片（`RoomCard`）与关注页的直播/频道卡片共用。桌面端
 * （`enabled: false`）所有处理器均为空操作，卡片继续使用右键菜单；
 * 长按计时与原生 contextmenu 触发的细节见 `useLongPress`。
 */
export function useLongPressDrawer({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  /** 长按触发后松手合成的点按不应再执行卡片默认动作。 */
  const suppressClickRef = useRef(false);
  const {
    onPointerDown: armLongPress,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    triggerNow,
  } = useLongPress({
    enabled,
    onTrigger: () => {
      suppressClickRef.current = true;
      setOpen(true);
    },
  });

  useEffect(() => {
    if (!open) return;
    // 按一次 Android Back 先收起操作抽屉，而不是离开当前页面。
    const closeOnAndroidBack = (event: Event) => {
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
  }, [open]);

  /**
   * 新一次按压开始：清掉上一次长按遗留的点按抑制，并武装长按计时。
   * 挂在卡片的点按交互面上，可与 DnD 激活器等其它 onPointerDown 链式组合。
   */
  const onPointerDown = useCallback(
    (event: PointerEvent) => {
      suppressClickRef.current = false;
      armLongPress(event);
    },
    [armLongPress],
  );

  /**
   * 移动端长按对应的原生 contextmenu（Android WebView 会派发）：拦下 WebView
   * 自带的菜单并立即打开抽屉。未启用时是空操作，可无条件挂在卡片上。
   */
  const onContextMenu = useCallback(
    (event: MouseEvent) => {
      if (!enabled) return;
      event.preventDefault();
      triggerNow();
    },
    [enabled, triggerNow],
  );

  /** 长按触发后松手合成的 click 被吞掉时返回 true；正常点按返回 false。 */
  const consumeSyntheticClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  return {
    open,
    setOpen,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onContextMenu,
    consumeSyntheticClick,
  };
}
