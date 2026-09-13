import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

/** 与 `volume-popover.tsx` 里 `VolumePopover` 的节奏一致，三个控制栏按钮手感相同。 */
const DEFAULT_DELAY = 200;
const DEFAULT_CLOSE_DELAY = 100;

export interface HoverOpenOptions {
  /** 指针在触发器上停留多久后展开（毫秒）。 */
  delay?: number;
  /** 指针离开后延迟多久收起（毫秒），留给指针跨越间隙进入弹层的时间。 */
  closeDelay?: number;
}

export interface HoverOpenHandlers {
  /** 挂在 `Menu.Trigger` 上：停留即展开。 */
  trigger: { onPointerEnter: () => void; onPointerLeave: () => void };
  /** 挂在 `Menu.Popup` 上：进入即取消待执行的收起。 */
  popup: {
    onPointerEnter: () => void;
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
  };
}

/** 指针是否真的悬停得起来。触屏没有悬停语义，保持点击开合。 */
function canHover() {
  return globalThis.matchMedia?.("(hover: hover)").matches ?? false;
}

/**
 * 弹层里还开着别的浮层（如字幕设置里的下拉选择）时不能收起菜单。
 *
 * 这些浮层由 Base UI 渲染到播放器舞台上，不在菜单的 DOM 里；指针一移进去就会判定
 * 「离开菜单」。Base UI 的触发器在浮层展开时带 `data-popup-open`，用它把这段时间
 * 让出来，菜单改由点击空白或 Esc 收起。
 */
function hasOpenNestedPopup(popup: HTMLElement | null) {
  return popup?.querySelector("[data-popup-open]") != null;
}

/**
 * 给 `Menu.Root` 补上 Video.js `Popover` 的 `openOnHover` 行为。
 *
 * `Menu` 原语只提供点击开合，而控制栏的音量按钮走的是 `VolumePopover`（`Popover`），
 * 悬停即可展开。播放设置与字幕菜单要和它一致，只能把同一套时序补在触发器与弹层上：
 * 停留 `delay` 后展开，离开后 `closeDelay` 内进入弹层则取消收起。
 *
 * 展开与收起都由调用方持有的 `open` 状态驱动，这里只负责时序。
 */
export function useHoverOpen(
  open: boolean,
  setOpen: (open: boolean) => void,
  { delay = DEFAULT_DELAY, closeDelay = DEFAULT_CLOSE_DELAY }: HoverOpenOptions = {},
): HoverOpenHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clear, [clear]);

  const arm = (next: boolean, ms: number) => {
    timer.current = setTimeout(() => setOpen(next), ms);
  };

  return {
    trigger: {
      onPointerEnter: () => {
        if (!canHover()) return;
        // 先撤掉待执行的收起：指针在 closeDelay 内折返时菜单不该闪一下。
        clear();
        if (!open) arm(true, delay);
      },
      onPointerLeave: () => {
        if (!canHover()) return;
        clear();
        if (open) arm(false, closeDelay);
      },
    },
    popup: {
      onPointerEnter: () => {
        if (canHover()) clear();
      },
      onPointerLeave: (event) => {
        if (!canHover()) return;
        clear();
        if (open && !hasOpenNestedPopup(event.currentTarget)) arm(false, closeDelay);
      },
    },
  };
}
