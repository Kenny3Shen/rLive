import { useGSAP } from "@gsap/react";
import { useQueryClient } from "@tanstack/react-query";
import gsap from "gsap";
import { useCallback, useRef, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { NavLink, useNavigate } from "react-router-dom";
import {
  Heart,
  History,
  Home,
  LayoutGrid,
  Videotape,
  Moon,
  PanelsTopLeft,
  Settings,
  Sun,
  Tv,
} from "lucide-react";
import { revealThemeAt } from "@/app/theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { preloadRouteModule } from "@/app/routeModules";
import { prefetchHomeRecommendations } from "@/features/home/homeQuery";
import { activeRecordingCount, useRecordings } from "@/features/recording/recording";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn } from "@/lib/utils";
import { SIDEBAR_NAVIGATION_STATE } from "./sidebarNavigation";

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
  className?: string;
};

const navItems: NavItem[] = [
  { to: "/", label: "首页", icon: Home, end: true },
  { to: "/follow", label: "关注", icon: Heart },
  { to: "/category", label: "分类", icon: LayoutGrid },
  { to: "/iptv", label: "IPTV", icon: Tv },
  { to: "/multi-room", label: "多画面", icon: PanelsTopLeft, className: "max-md:hidden" },
  { to: "/recordings", label: "录制", icon: Videotape, className: "max-md:hidden" },
];

function SidebarLink({
  to,
  label,
  icon: Icon,
  end,
  className,
  badgeCount = 0,
  badgeLabel,
  onIntent,
}: NavItem & {
  /** Rendered as a small counter over the icon when greater than zero. */
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
                // A solid fill rather than the tinted `destructive` variant: a
                // counter this small has to stay readable over the icon it
                // covers, and the sidebar-coloured ring keeps it detached.
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
  const { contextSafe } = useGSAP({ scope: buttonRef });
  const animateToggle = contextSafe((rotation: number) => {
    const button = buttonRef.current;
    if (!button || prefersReducedMotion()) return;

    gsap.killTweensOf(button);
    gsap.fromTo(
      button,
      { rotation, scale: 0.94, willChange: "transform" },
      {
        rotation: 0,
        scale: 1,
        duration: 0.18,
        ease: "power2.out",
        clearProps: "transform,willChange",
      },
    );
  });

  function handleThemeToggle(event: MouseEvent<HTMLButtonElement>) {
    if (switchingRef.current) return;
    switchingRef.current = true;

    const keyboardActivation = event.detail === 0;
    if (keyboardActivation) {
      flushSync(() => setTheme(nextTheme));
      switchingRef.current = false;
      return;
    }
    const transition = revealThemeAt({ x: event.clientX, y: event.clientY }, () =>
      flushSync(() => setTheme(nextTheme)),
    );

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
            className="size-8 max-md:size-11 max-md:rounded-lg"
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
  // The recording list is already shared and event-driven, so subscribing here
  // keeps the badge live without adding a second polling source.
  const recordings = useRecordings();
  const activeRecordings = activeRecordingCount(recordings.data);
  const preloadHome = useCallback(() => {
    prefetchHomeRecommendations(queryClient, siteId);
  }, [queryClient, siteId]);

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
        {navItems.map((item) => {
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
        })}
        <div data-slot="app-sidebar-preferences" className="mt-auto max-md:hidden">
          <AppearanceToggle />
        </div>
        <SidebarLink to="/history" label="历史" icon={History} />
        <SidebarLink to="/settings" label="设置" icon={Settings} />
      </nav>
    </aside>
  );
}
