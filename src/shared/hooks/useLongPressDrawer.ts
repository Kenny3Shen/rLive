import { useCallback, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { useLongPress } from "@/shared/hooks/useLongPress";

/**
 * 「长按卡片弹出底部操作抽屉」的公共接线。
 *
 * 封装长按检测、抽屉开关与触发后松手合成 click 的抑制，由直播卡片
 * （`RoomCard`）与关注页的直播/频道卡片共用。桌面端（`enabled: false`）
 * 所有处理器均为空操作，卡片继续使用右键菜单；长按计时与原生 contextmenu
 * 触发的细节见 `useLongPress`。Android Back 收起抽屉由 `AndroidBackNavigator`
 * 统一处理（抽屉是 base-ui 弹窗），这里不再自己监听。
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
    ownsActivePress,
  } = useLongPress({
    enabled,
    onTrigger: () => {
      suppressClickRef.current = true;
      setOpen(true);
    },
  });

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
   *
   * 只有归属本卡片按压的 contextmenu 才会触发抽屉：遮罩退出期间系统长按
   * 可能重定向到下层卡片，那种伪信号会把刚收起的抽屉再次弹开，必须忽略；
   * preventDefault 仍然保留，避免 WebView 弹出自带菜单。
   */
  const onContextMenu = useCallback(
    (event: MouseEvent) => {
      if (!enabled) return;
      event.preventDefault();
      if (!ownsActivePress()) return;
      triggerNow();
    },
    [enabled, triggerNow, ownsActivePress],
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
