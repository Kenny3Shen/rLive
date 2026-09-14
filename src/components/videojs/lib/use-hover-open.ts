import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

/** 菜单关闭后焦点归还触发器的时间窗（毫秒），见 `useFocusReturnGuard`。 */
const FOCUS_RETURN_WINDOW_MS = 400;

/**
 * 菜单关闭后 video.js 会把焦点归还触发器（`createMenu` 的 `restoreFocus`）。tooltip 的
 * `onFocusIn` 不区分焦点来源，指针早已离开时会把 tooltip 重新打开，且之后再没有任何
 * 事件能关掉它 —— 表现为「播放设置」tooltip 常驻到控制条 autohide。
 *
 * 规避：菜单刚关闭的时间窗内触发器获得焦点、而指针又不在其上时，立即交还焦点。
 * 键盘导航的聚焦远离该窗口，不受影响。
 */
export function useFocusReturnGuard(closedAt: { current: number }) {
  // `closedAt` 是稳定的 ref 容器；exhaustive-deps 对 ref.current 的警告不影响正确性。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(
    (event: { currentTarget: HTMLElement }) => {
      const sinceClose = performance.now() - closedAt.current;
      if (sinceClose > FOCUS_RETURN_WINDOW_MS) return;
      const trigger = event.currentTarget;
      requestAnimationFrame(() => {
        if (document.activeElement === trigger && !trigger.matches(":hover")) trigger.blur();
      });
    },
    // 依赖 ref 容器本身即可：容器引用稳定，读值发生在回调执行时。
    [closedAt],
  );
}

/** 与 `volume-popover.tsx` 里 `VolumePopover` 的节奏一致，三个控制栏按钮手感相同。 */
const DEFAULT_DELAY = 200;
const DEFAULT_CLOSE_DELAY = 100;

export interface HoverOpenOptions {
  /** 指针在触发器上停留多久后展开（毫秒）。 */
  delay?: number;
  /** 指针离开后延迟多久收起（毫秒），留给指针跨越间隙进入弹层的时间。 */
  closeDelay?: number;
}

/**
 * 控制栏悬停菜单共用的开合请求。形状取 Video.js `Menu.Root` 与 Base UI `Popover`
 * 两者的公共子集，因此同一份 `onOpenChange` 能直接挂到两边。
 *
 * `reason` 覆盖两套词汇：Video.js 用 `click`，Base UI 用 `trigger-press`。
 * `event` 用来区分真指针点按（`type === "click"` 且 `detail > 0`）与键盘合成的 click
 *（`detail === 0`）以及菜单项选择（Video.js 不带 event）。
 */
export interface OpenChangeRequest {
  reason?: string;
  event?: { type: string; detail?: number } | null;
  /** Base UI 用它阻止内部提交；Video.js 没有对应字段，忽略即可。 */
  cancel?: () => void;
}

export interface HoverOpenHandlers {
  /** 挂在 `Menu.Trigger` 上：停留即展开；`onFocus` 兜底拦截关闭后的焦点归还。 */
  trigger: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: (event: { currentTarget: HTMLElement }) => void;
  };
  /** 挂在 `Menu.Popup` 上：进入即取消待执行的收起。 */
  popup: {
    onPointerEnter: () => void;
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  /**
   * 挂在 `Menu.Root` / `Popover` 的 `onOpenChange` 上。
   *
   * 悬停已展开时，触发器上的真指针点按不再把菜单收回（音量按钮同构：hover 开、
   * 移开收，点触发器本身不关）。触屏没有悬停，仍按点击开合；键盘 Enter/Space
   * 合成的 click（`detail === 0`）同样保留开合。Esc、点空白、选项选择不受影响。
   */
  onOpenChange: (open: boolean, details?: OpenChangeRequest) => void;
}

/** 指针是否真的悬停得起来。触屏没有悬停语义，保持点击开合。 */
function canHover() {
  return globalThis.matchMedia?.("(hover: hover)").matches ?? false;
}

/**
 * 悬停已展开的菜单不该被触发器上的真指针点按收回。
 *
 * 两套原语都会在触发器 click 时再发一次关合：Video.js `Menu` 的 `reason` 是 `click`，
 * Base UI `Popover` 是 `trigger-press`。键盘合成的 click（`detail === 0`）和菜单项
 * 选择（Video.js 不带 event）都不是这条路径，继续关。
 */
export function ignoresTriggerPressClose(
  nextOpen: boolean,
  details: OpenChangeRequest | undefined,
  hoverCapable: boolean,
): boolean {
  if (nextOpen || !hoverCapable) return false;
  const reason = details?.reason;
  if (reason !== "click" && reason !== "trigger-press") return false;
  const event = details?.event;
  if (event == null) return false;
  if (event.type !== "click") return false;
  return (event.detail ?? 1) > 0;
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
 * 展开与收起都由调用方持有的 `open` 状态驱动，这里只负责时序；`onOpenChange`
 * 还负责把「悬停展开后点触发器」这次关合请求挡掉（见 `ignoresTriggerPressClose`）。
 */
export function useHoverOpen(
  open: boolean,
  setOpen: (open: boolean) => void,
  { delay = DEFAULT_DELAY, closeDelay = DEFAULT_CLOSE_DELAY }: HoverOpenOptions = {},
): HoverOpenHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** `open` 翻 false 的时刻，供 `useFocusReturnGuard` 判定焦点归还是否来自菜单关闭。 */
  const closedAtRef = useRef(0);
  const focusReturnGuard = useFocusReturnGuard(closedAtRef);
  // setOpen 包装：记录关闭时刻。菜单关闭动画结束后 video.js 的 restoreFocus 会把焦点
  // 归还触发器，tooltip 随之重开且再无事件能关掉它；guard 在时间窗内把焦点交还。
  const setOpenTracked = useCallback(
    (next: boolean) => {
      if (!next) closedAtRef.current = performance.now();
      setOpen(next);
    },
    [setOpen],
  );
  const clear = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clear, [clear]);

  const arm = (next: boolean, ms: number) => {
    timer.current = setTimeout(() => setOpenTracked(next), ms);
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
      onFocus: focusReturnGuard,
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
    onOpenChange: (nextOpen, details) => {
      if (ignoresTriggerPressClose(nextOpen, details, canHover())) {
        // Base UI 的 Popover 会自行提交内部 store，必须显式取消；Video.js 的 Menu
        // 走 `deferOpenChanges`，不回写 open 状态就等于没发生。
        details?.cancel?.();
        return;
      }
      // 已有明确结果，待执行的悬停计时器不能再把状态翻回去。
      clear();
      setOpenTracked(nextOpen);
    },
  };
}
