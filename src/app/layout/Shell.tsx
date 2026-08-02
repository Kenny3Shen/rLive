import { useCallback, useEffect, useMemo, useRef } from "react";
import { Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { SiteSwitcher } from "@/shared/components/SiteSwitcher";
import { HeaderSearch } from "@/shared/components/HeaderSearch";
import { categoryHomePathAfterSiteChange } from "@/features/category/categoryRoute";
import {
  FOLLOW_PLATFORM_PARAM,
  type FollowPlatformFilter,
  followPlatformFromSearch,
  withFollowPlatform,
} from "@/features/follow/followRoute";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import { isMobileClient } from "@/shared/clientPlatform";
import { enabledSiteIds } from "@/shared/siteId";
import type { SiteId } from "@/shared/types/live";
import { Sidebar } from "./Sidebar";
import { AppTitleBar } from "./AppTitleBar";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn } from "@/lib/utils";

export function Shell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isRoom = pathname.startsWith("/room/");
  const isIptvPlayer = pathname === "/iptv/play";
  const isImmersivePlayer = isRoom || isIptvPlayer;
  const isFollow = pathname === "/follow";

  // React Router records each pushState entry with an incrementing `idx`.
  // Comparing it across renders tells the tab transition which way the user
  // moved through history so the incoming page can slide in from that side.
  // Written idempotently during render, the refs only mirror the last view.
  const historyIndex = typeof window !== "undefined" ? ((window.history.state as { idx?: number } | null)?.idx ?? 0) : 0;
  const prevPathRef = useRef(pathname);
  const prevHistoryIndexRef = useRef(historyIndex);
  const isTabNavigation =
    pathname !== prevPathRef.current && historyIndex !== prevHistoryIndexRef.current;
  const tabDirection: "forward" | "backward" | null = isTabNavigation
    ? historyIndex > prevHistoryIndexRef.current
      ? "forward"
      : "backward"
    : null;
  prevPathRef.current = pathname;
  prevHistoryIndexRef.current = historyIndex;

  const selectedSiteId = useSettingsStore((state) => state.siteId);
  const setSiteId = useSettingsStore((state) => state.setSiteId);
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const showSiteSwitcher =
    pathname === "/" ||
    pathname.startsWith("/category") ||
    pathname.startsWith("/search") ||
    isFollow;
  const rawFollowPlatform = followPlatformFromSearch(searchParams.get(FOLLOW_PLATFORM_PARAM));
  const followPlatform = followPlatformFromSearch(
    searchParams.get(FOLLOW_PLATFORM_PARAM),
    disabledSiteIds,
  );
  const platformForMotion = isFollow ? followPlatform : selectedSiteId;
  const pageMotionKey = isImmersivePlayer ? pathname : `${pathname}:${platformForMotion}`;
  const categoryHomePath = categoryHomePathAfterSiteChange(pathname);
  // Keep a definite height chain from the shell to each route. Regular pages
  // may still grow past it (main owns overflow), while their gesture surfaces
  // can resolve min-h-full and cover otherwise empty viewport space.
  const outletHeightClass = "h-full min-h-0";

  const sitePlatforms = useMemo(
    () => enabledSiteIds(disabledSiteIds) as SiteId[],
    [disabledSiteIds],
  );
  const activeSiteId = useMemo(
    () =>
      sitePlatforms.includes(selectedSiteId as SiteId)
        ? (selectedSiteId as SiteId)
        : sitePlatforms[0]!,
    [selectedSiteId, sitePlatforms],
  );
  const followPlatforms = useMemo<FollowPlatformFilter[]>(
    () => ["all", ...sitePlatforms],
    [sitePlatforms],
  );

  const handleSitePlatformChange = useCallback(
    (nextSiteId: SiteId) => {
      if (nextSiteId === activeSiteId) return;
      setSiteId(nextSiteId);
      if (categoryHomePath) {
        navigate(categoryHomePath, { replace: true });
      }
    },
    [activeSiteId, categoryHomePath, navigate, setSiteId],
  );

  const handleFollowPlatformChange = useCallback(
    (platform: FollowPlatformFilter) => {
      setSearchParams((current) => withFollowPlatform(current, platform));
    },
    [setSearchParams],
  );

  // Simple Live's home/category/search use TabBarView: a horizontal content
  // swipe changes the active platform. Keep that contract on touch clients.
  const platformSwipeEnabled = showSiteSwitcher && isMobileClient();
  const sitePlatformSwipe = useHorizontalSwipe({
    items: sitePlatforms,
    value: activeSiteId,
    onChange: handleSitePlatformChange,
    enabled: platformSwipeEnabled && !isFollow,
  });
  const followPlatformSwipe = useHorizontalSwipe({
    items: followPlatforms,
    value: followPlatform,
    onChange: handleFollowPlatformChange,
    enabled: platformSwipeEnabled && isFollow,
  });
  const platformSwipe = isFollow ? followPlatformSwipe : sitePlatformSwipe;

  // A manually opened URL may name a platform that has since been disabled.
  // Keep the page usable on its first render, then remove that stale filter
  // from the address bar without adding a history entry.
  useEffect(() => {
    if (!isFollow || rawFollowPlatform === followPlatform) return;
    setSearchParams((current) => withFollowPlatform(current, followPlatform), { replace: true });
  }, [followPlatform, isFollow, rawFollowPlatform, setSearchParams]);

  return (
    <div className="app-shell flex h-full min-h-0 flex-col bg-background max-md:pt-[env(safe-area-inset-top)]">
      <AppTitleBar />
      <div className="flex min-h-0 min-w-0 flex-1">
        {!isImmersivePlayer && <Sidebar />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!isImmersivePlayer && (
            <header
              data-slot="app-header"
              data-mobile-empty={showSiteSwitcher ? undefined : "true"}
              className={cn(
                "relative flex h-14 shrink-0 items-center border-b border-border-subtle px-4 max-md:h-12 max-md:gap-2 max-md:px-3",
                !showSiteSwitcher && "max-md:hidden",
              )}
            >
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center max-md:relative max-md:inset-auto max-md:min-w-0 max-md:flex-1 max-md:justify-start max-md:overflow-hidden">
                {showSiteSwitcher && (
                  <div className="pointer-events-auto max-md:min-w-max">
                    {isFollow ? (
                      <SiteSwitcher
                        value={followPlatform}
                        includeAll
                        filterMode
                        onValueChange={handleFollowPlatformChange}
                      />
                    ) : (
                      <SiteSwitcher
                        onValueChange={(value) => {
                          if (value === "all") return;
                          handleSitePlatformChange(value);
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
              <div className="relative z-10 ml-auto flex items-center">
                <HeaderSearch />
              </div>
            </header>
          )}
          <main
            data-slot="app-content"
            className={cn(
              "min-h-0 min-w-0 flex-1",
              isImmersivePlayer
                ? "overflow-hidden p-0"
                : // touch-pan-y keeps vertical list scroll native while horizontal
                  // platform swipes and pull-to-refresh stay available to JS.
                  "overflow-auto overscroll-y-contain p-4 pb-[calc(4.75rem+env(safe-area-inset-bottom))] touch-pan-y md:p-5 md:pb-5",
            )}
            onPointerDownCapture={platformSwipe.onPointerDownCapture}
            onPointerMoveCapture={platformSwipe.onPointerMoveCapture}
            onPointerUpCapture={platformSwipe.onPointerUpCapture}
            onPointerCancelCapture={platformSwipe.onPointerCancelCapture}
            onClickCapture={platformSwipe.onClickCapture}
          >
            <div
              key={pageMotionKey}
              className={cn(
                "relative",
                outletHeightClass,
                !isImmersivePlayer &&
                  (tabDirection === "forward"
                    ? "animate-tab-page-enter-forward"
                    : tabDirection === "backward"
                      ? "animate-tab-page-enter-backward"
                      : "motion-safe:animate-platform-page-enter motion-reduce:animate-none"),
              )}
            >
              <div className={cn("relative", outletHeightClass)}>
                <Outlet />
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
