import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { NavLink, useNavigate } from "react-router-dom";
import { ArrowUpCircle, Moon, Sun } from "lucide-react";
import { fadeTheme } from "@/app/theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { preloadRouteModule } from "@/app/routeModules";
import { prefetchHomeRecommendations } from "@/features/home/homeQuery";
import { activeRecordingCount, useActiveRecordings } from "@/features/recording/recording";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import { EASE_OUT, prefersReducedMotion } from "@/shared/motion/tokens";
import { hasLongPressMovedBeyondSlop } from "@/shared/gestures/longPress";
import { killTweensOf, settleTween, tween } from "@/shared/motion/tween";
import { isMobileClient } from "@/shared/clientPlatform";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { useUpdateStore } from "@/shared/update/updateStore";
import { cn } from "@/lib/utils";
import {
  SIDEBAR_NAVIGATION_STATE,
  sidebarNavItemsFor,
  type SidebarNavItem,
} from "./sidebarNavigation";

/**
 * 触摸在底栏上自行导航后，抑制随后到达的兼容 click 的时长（ms）。
 *
 * 与 `HORIZONTAL_SWIPE_CLICK_SUPPRESSION_MS` 同量级：延迟的 click 一般紧跟着
 * `pointerup` 到达，这个窗口足够盖住它；超出窗口的 click 一定是用户新的一次操作，
 * 不该被吞。
 */
const SIDEBAR_TAP_CLICK_SUPPRESSION_MS = 420;

/**
 * 触摸点按的最大时长（ms）。超过它视为长按而不是点按。
 *
 * 移动端底栏上的长按没有额外语义（不是卡片长按抽屉那一类），但按住半秒再松手
 * 仍不该算一次点按 —— 那通常是用户在犹豫或误触。与 `LONG_PRESS_TRIGGER_MS`
 * 同档。
 */
const SIDEBAR_TAP_MAX_DURATION_MS = 500;

function SidebarLink({
  to,
  label,
  icon: Icon,
  end,
  className,
  badgeCount = 0,
  badgeLabel,
  onIntent,
}: SidebarNavItem & {
  /** 大于零时以图标上的小计数徽标呈现。 */
  badgeCount?: number;
  badgeLabel?: string;
  onIntent?: () => void;
}) {
  const navigate = useNavigate();
  /**
   * 触摸指针在底栏上的落点与时刻，用来在 fling 期间自行合成一次导航。
   *
   * 惯性滚动还在跑时，浏览器的第一次点按只用来停住滚动：`pointerdown` /
   * `pointerup` 照常派发，`click` 却被吞掉（Chromium 的 scroll gesture 会吃掉
   * 这一次 tap）。底栏是固定在滚动容器之外的一层，用户想点它的时候滚动可能还
   * 在滑，于是「点一下没反应，得再点一下」—— 底栏因此读作失灵。
   *
   * 这里在 `pointerup` 上自己判定并导航，不等 `click`；随后的兼容 `click`
   * 用时间窗去重（见 `handleClick`）。只处理触摸：鼠标与键盘走原来的
   * `NavLink` 路径，不产生第二次导航。
   */
  const tapRef = useRef<{ pointerId: number; x: number; y: number; time: number } | null>(null);
  /** 自行导航后，抑制随后到达的兼容 click。 */
  const suppressClickUntilRef = useRef(0);

  function preloadDestination() {
    preloadRouteModule(to);
    onIntent?.();
  }

  /**
   * 导航到本条目。
   *
   * `state` 必须是 `SIDEBAR_NAVIGATION_STATE`：Shell 靠它把这一次跳转识别为
   * 「底部导航直达」并据此选页面转场（移动端原子式换页、桌面端方向平移）。
   * 用 `NavLink` 自己的点击处理器做不到这一点 —— 那是它的内部逻辑，
   * 只能靠真正点击那一下走进去。
   */
  const goToDestination = useCallback(() => {
    navigate(to, { state: SIDEBAR_NAVIGATION_STATE });
  }, [navigate, to]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLAnchorElement>) => {
      // 预加载不走回调引用：`preloadDestination` 每次渲染都是新函数（它读 `to`
      // 与 `onIntent`），把它列进依赖会让本处理器也每次重建，而它自己并不需要
      // 新的闭包 —— 这里直接调用即可。
      preloadDestination();
      // 部分 Android WebView 对手指输入上报空的 pointerType。
      const pointerType = event.pointerType as string;
      if (pointerType !== "touch" && pointerType !== "") {
        tapRef.current = null;
        return;
      }
      if (!event.isPrimary || event.button !== 0) {
        tapRef.current = null;
        return;
      }
      tapRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
      };
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上方注释。
    [],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLAnchorElement>) => {
      const tap = tapRef.current;
      tapRef.current = null;
      if (!tap || tap.pointerId !== event.pointerId) return;
      if (
        hasLongPressMovedBeyondSlop(tap.x, tap.y, event.clientX, event.clientY) ||
        event.timeStamp - tap.time > SIDEBAR_TAP_MAX_DURATION_MS
      ) {
        return;
      }
      // 指针已被祖先（横向翻页）捕获时不在这里导航：那一层会用自己的收尾与
      // 点按抑制决定结果，两边都动手会翻两次。
      if (event.currentTarget.hasPointerCapture(event.pointerId)) return;
      suppressClickUntilRef.current = Date.now() + SIDEBAR_TAP_CLICK_SUPPRESSION_MS;
      goToDestination();
    },
    [goToDestination],
  );

  const handlePointerCancel = useCallback(() => {
    tapRef.current = null;
  }, []);

  const link = (
    <NavLink
      to={to}
      end={end}
      state={SIDEBAR_NAVIGATION_STATE}
      onPointerEnter={preloadDestination}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onFocus={preloadDestination}
      onClick={(event) => {
        // 触摸已经在 `pointerup` 上导航过：这里的兼容 click 只负责把默认行为
        // （整页跳转）压下去，不能再走一次路由，否则同一次点按会导航两遍。
        if (Date.now() < suppressClickUntilRef.current) {
          event.preventDefault();
          return;
        }
        // `detail === 0` 是键盘触发的 click（Enter / 空格），鼠标 click 的
        // detail 是点击次数；两者都交给 `NavLink` 自己处理。
        if (event.detail !== 0) return;
        event.preventDefault();
        goToDestination();
      }}
      data-slot="app-sidebar-link"
      data-motion-press
      className={({ isActive }) =>
        cn(
          "group relative flex h-10 w-10 items-center justify-center rounded-xl",
          // 平板（≥md 的粗指针）沿用竖排 rail，但按移动端待遇呈现：
          // 48px 命中区加图标下方的文字标签 —— 悬停 tooltip 在触摸上不存在，
          // 无标签的纯图标 rail 在平板上无法自解释。
          "touch-wide:h-auto touch-wide:min-h-12 touch-wide:w-auto touch-wide:min-w-12 touch-wide:flex-col touch-wide:gap-0.5 touch-wide:rounded-lg touch-wide:px-1.5 touch-wide:py-1",
          "max-md:h-auto max-md:min-h-12 max-md:w-auto max-md:min-w-0 max-md:flex-1 max-md:flex-col max-md:gap-0.5 max-md:rounded-lg max-md:px-1 max-md:py-0.5",
          className,
          // 移动端底栏不给整格铺底：选中态由图标背后的胶囊指示器表达（见 styles.css
          // 的 `app-sidebar-indicator`），整格只换文字颜色。桌面竖栏沿用整格高亮。
          isActive
            ? "text-primary md:bg-primary/12 md:shadow-sm md:shadow-primary/10 md:ring-1 md:ring-primary/15"
            : "text-muted-foreground hover:text-foreground md:hover:bg-muted/70",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span data-slot="app-sidebar-indicator" className="relative inline-flex shrink-0">
            <span className="relative inline-flex">
              <Icon
                className={cn(
                  "motion-nav-icon size-5 transition-transform duration-150 ease-[var(--motion-ease-out)] motion-reduced:transition-none",
                  isActive && "text-primary",
                )}
              />
              {badgeCount > 0 && (
                <Badge
                  variant="default"
                  aria-label={badgeLabel}
                  // 用实心填充而不是着色的 `destructive` 变体：这么小的计数必须在其覆盖的图标
                  // 上保持可读，侧栏色的描边让它与图标脱开。
                  className="pointer-events-none absolute -top-1.5 -right-2 h-4 min-w-4 justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold tabular-nums text-white ring-2 ring-sidebar"
                >
                  {badgeCount > 99 ? "99+" : badgeCount}
                </Badge>
              )}
            </span>
          </span>
          <span
            data-slot="app-sidebar-label"
            className="sr-only max-md:not-sr-only max-md:block max-md:max-w-full max-md:truncate max-md:text-[11px] max-md:leading-3.5 max-md:font-medium touch-wide:not-sr-only touch-wide:block touch-wide:max-w-full touch-wide:truncate touch-wide:text-[10px] touch-wide:leading-3 touch-wide:font-medium"
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right" className="max-md:hidden touch-wide:hidden">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** 有新版本时出现的独立入口；点开更新对话框，不再借设置图标的徽标提示。 */
function UpdateButton() {
  const updateAvailable = useUpdateStore((state) => state.status === "available");
  const version = useUpdateStore((state) => state.release?.version);
  const showDialog = useUpdateStore((state) => state.showDialog);

  if (!updateAvailable) return null;
  const label = version ? `发现新版本 v${version}` : "发现新版本";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-slot="update-entry"
            variant="ghost"
            size="icon-sm"
            className="size-8 bg-primary/12 text-primary ring-1 ring-primary/15 hover:bg-primary/20 hover:text-primary"
            aria-label={label}
            onClick={showDialog}
          />
        }
      >
        <ArrowUpCircle data-icon="inline-start" aria-hidden />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function AppearanceToggle() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const switchingRef = useRef(false);
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const isDark =
    theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"));
  const nextTheme = isDark ? "light" : "dark";
  const label = isDark ? "切换为浅色模式" : "切换为深色模式";
  const Icon = isDark ? Sun : Moon;
  const animateToggle = (rotation: number) => {
    const button = buttonRef.current;
    if (!button || prefersReducedMotion()) return;

    killTweensOf(button);
    button.style.willChange = "transform";
    // 结束帧（无旋转、原始尺寸）与自然态一致，settleTween 会归还行内样式。
    settleTween(
      button,
      tween(
        button,
        [
          { transform: `rotate(${rotation}deg) scale(0.94)` },
          { transform: "rotate(0deg) scale(1)" },
        ],
        { duration: 180, easing: EASE_OUT, fill: "both" },
      ),
    );
  };

  function handleThemeToggle() {
    if (switchingRef.current) return;
    switchingRef.current = true;

    const transition = fadeTheme(() => flushSync(() => setTheme(nextTheme)));
    void transition.ready.then(() => animateToggle(isDark ? -12 : 12));
    void transition.finished.then(() => {
      switchingRef.current = false;
    });
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={buttonRef}
            data-slot="appearance-toggle"
            variant="ghost"
            size="icon-sm"
            className="size-8"
            aria-label={label}
            aria-pressed={isDark}
            onClick={handleThemeToggle}
          />
        }
      >
        <Icon data-icon="inline-start" aria-hidden />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar() {
  const queryClient = useQueryClient();
  const siteId = useSiteId();
  // 侧栏角标只关心「有几个任务在跑」，不读完整录制库：
  // 那会在启动时触发历史根扫描。
  const recordings = useActiveRecordings();
  const activeRecordings = activeRecordingCount(recordings.data);
  const preloadHome = useCallback(() => {
    prefetchHomeRecommendations(
      queryClient,
      siteId,
      useSettingsStore.getState().bilibiliAppAuthRevision,
    );
  }, [queryClient, siteId]);
  // 桌面专属入口（多画面/录制）、更新入口与亮暗模式快捷切换都按客户端平台门控，
  // 而不是只靠视口断点：手机/平板横屏宽度普遍超过 md，
  // `max-md:hidden` 会让它们漏进移动端底栏。移动端的亮暗切换
  // 统一放在设置页外观分区。
  const mobileClient = isMobileClient();
  const hiddenHomeEntryIds = useSettingsStore((state) => state.hiddenHomeEntryIds);
  const navItems = sidebarNavItemsFor(mobileClient, hiddenHomeEntryIds);
  // 历史/设置归入底部分组：桌面竖栏里与亮暗切换一起被 mt-auto 推到底部，
  // 移动端底栏里该分组退化为 display:contents，条目回到行内流。
  const mainNavItems = navItems.filter((item) => !item.footer);
  const footerNavItems = navItems.filter((item) => item.footer);

  const renderNavItem = (item: SidebarNavItem) => {
    const recordingBadge = item.to === "/recordings" ? activeRecordings : 0;
    return (
      <SidebarLink
        key={item.to}
        {...item}
        badgeCount={recordingBadge}
        badgeLabel={recordingBadge > 0 ? `${recordingBadge} 项录制进行中` : undefined}
        onIntent={item.to === "/" ? preloadHome : undefined}
      />
    );
  };

  return (
    <aside
      data-slot="app-sidebar"
      className="flex h-full w-[68px] shrink-0 flex-col items-center border-r border-border-subtle bg-sidebar/95 py-3 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-20 max-md:h-[calc(4.25rem+var(--app-safe-area-bottom))] max-md:w-auto max-md:flex-row max-md:border-t max-md:border-r-0 max-md:px-2 max-md:py-2 max-md:pb-[calc(0.5rem+var(--app-safe-area-bottom))]"
    >
      <nav
        data-slot="app-sidebar-nav"
        className="flex w-full flex-1 flex-col items-center gap-2 max-md:min-w-0 max-md:flex-row max-md:justify-start max-md:gap-0 max-md:overflow-hidden"
        aria-label="主导航"
      >
        {mainNavItems.map(renderNavItem)}
        <div
          data-slot="app-sidebar-footer"
          className="mt-auto flex flex-col items-center gap-2 max-md:contents"
        >
          {!mobileClient && (
            <div
              data-slot="app-sidebar-preferences"
              className="flex flex-col items-center gap-2 max-md:hidden"
            >
              <UpdateButton />
              <AppearanceToggle />
            </div>
          )}
          {footerNavItems.map(renderNavItem)}
        </div>
      </nav>
    </aside>
  );
}
