import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { NavLink, useNavigate } from "react-router-dom";
import { ArrowUpCircle, Moon, Sun } from "lucide-react";
import { fadeTheme } from "@/app/theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { preloadRouteModule } from "@/app/routeModules";
import { prefetchHomeRecommendations } from "@/features/home/homeQuery";
import { activeRecordingCount, useRecordings } from "@/features/recording/recording";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import { EASE_OUT, prefersReducedMotion } from "@/shared/motion/tokens";
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

  function preloadDestination() {
    preloadRouteModule(to);
    onIntent?.();
  }

  const link = (
    <NavLink
      to={to}
      end={end}
      state={SIDEBAR_NAVIGATION_STATE}
      onPointerEnter={preloadDestination}
      onPointerDown={preloadDestination}
      onFocus={preloadDestination}
      onClick={(event) => {
        if (event.detail !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
      data-slot="app-sidebar-link"
      data-motion-press
      className={({ isActive }) =>
        cn(
          "group relative flex h-10 w-10 items-center justify-center rounded-xl focus-ring max-md:h-auto max-md:min-h-12 max-md:w-auto max-md:min-w-0 max-md:flex-1 max-md:flex-col max-md:gap-0.5 max-md:rounded-lg max-md:px-1 max-md:py-1",
          className,
          isActive
            ? "bg-primary/12 text-primary ring-1 ring-primary/15 shadow-sm shadow-primary/10"
            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className="relative inline-flex shrink-0">
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
          <span
            data-slot="app-sidebar-label"
            className="sr-only max-md:not-sr-only max-md:block max-md:max-w-full max-md:truncate max-md:text-[10px] max-md:leading-3 max-md:font-medium"
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
      <TooltipContent side="right" className="max-md:hidden">
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
  // 录制列表已经是共享且事件驱动的，在这里订阅即可让徽标保持实时，
  // 又不必增加第二个轮询源。
  const recordings = useRecordings();
  const activeRecordings = activeRecordingCount(recordings.data);
  const preloadHome = useCallback(() => {
    prefetchHomeRecommendations(queryClient, siteId);
  }, [queryClient, siteId]);
  // 桌面专属入口（多画面/录制）、更新入口与亮暗模式快捷切换都按客户端平台门控，
  // 而不是只靠视口断点：手机/平板横屏宽度普遍超过 md，
  // `max-md:hidden` 会让它们漏进移动端底栏。移动端的亮暗切换
  // 统一放在设置页外观分区。
  const mobileClient = isMobileClient();
  const navItems = sidebarNavItemsFor(mobileClient);
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
      className="flex h-full w-[68px] shrink-0 flex-col items-center border-r border-border-subtle bg-sidebar/95 py-3 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-20 max-md:h-[calc(4.25rem+env(safe-area-inset-bottom))] max-md:w-auto max-md:flex-row max-md:border-t max-md:border-r-0 max-md:px-2 max-md:py-2 max-md:pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
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
