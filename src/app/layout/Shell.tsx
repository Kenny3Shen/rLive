import {
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, m } from "motion/react";
import {
  useLocation,
  useNavigate,
  useNavigationType,
  useOutlet,
  useSearchParams,
} from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Spinner } from "@/components/ui/spinner";
import {
  IptvHeaderStatusControls,
  IptvSearchInput,
  IptvSourceSwitcher,
} from "@/features/iptv/IptvHeaderControls";
import { IptvControllerProvider } from "@/features/iptv/IptvController";
import { iptvHomePath } from "@/features/iptv/iptvRoute";
import { builtInSources, playlistSourceFromRoute } from "@/features/iptv/playlistSource";
import { HistoryHeaderControls } from "@/features/history/HistoryHeaderControls";
import {
  HISTORY_PLATFORM_PARAM,
  type HistoryPlatformFilter,
  historyPlatformFromSearch,
  withHistoryPlatform,
} from "@/features/history/historyRoute";
import { useHistoryShellStore } from "@/features/history/historyShellStore";
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
import { motionProfile, tabVariants } from "@/shared/motion/tokens";
import { isMobileClient } from "@/shared/clientPlatform";
import { enabledSiteIds } from "@/shared/siteId";
import { PlatformScope, type PlatformScopeValue } from "@/shared/hooks/useSiteQuery";
import type { SiteId } from "@/shared/types/live";
import { Sidebar } from "./Sidebar";
import { AppTitleBar } from "./AppTitleBar";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn } from "@/lib/utils";
import { isSidebarNavigation } from "./sidebarNavigation";
import { prefetchHomeRecommendations } from "@/features/home/homeQuery";

function RouteLoadingFallback() {
  return (
    <div
      className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Spinner role="presentation" aria-hidden />
      正在加载…
    </div>
  );
}

function RouteOutlet({
  defer,
  outlet,
  platform,
}: {
  defer: boolean;
  outlet: ReactNode;
  platform: PlatformScopeValue;
}) {
  const [ready, setReady] = useState(!defer);

  useEffect(() => {
    if (!defer) return;

    const frame = window.requestAnimationFrame(() => {
      startTransition(() => setReady(true));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [defer]);

  if (!ready) return <RouteLoadingFallback />;

  return (
    <PlatformScope value={platform}>
      <Suspense fallback={<RouteLoadingFallback />}>{outlet}</Suspense>
    </PlatformScope>
  );
}

export function Shell() {
  const location = useLocation();
  const { pathname } = location;
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const outlet = useOutlet();
  const [searchParams, setSearchParams] = useSearchParams();
  const isRoom = pathname.startsWith("/room/");
  const isIptv = pathname === "/iptv";
  const isIptvPlayer = pathname === "/iptv/play";
  const isImmersivePlayer = isRoom || isIptvPlayer;
  const isFollow = pathname === "/follow";
  const isHistory = pathname === "/history";

  // React Router records each pushState entry with an incrementing `idx`.
  // Comparing it across renders tells the tab transition which way the user
  // moved through history so the incoming page can slide in from that side.
  // Written idempotently during render, the refs only mirror the last view.
  const historyIndex =
    typeof window !== "undefined"
      ? ((window.history.state as { idx?: number } | null)?.idx ?? 0)
      : 0;
  const prevPathRef = useRef(pathname);
  const prevHistoryIndexRef = useRef(historyIndex);
  const directSidebarPathRef = useRef<string | null>(null);
  const pathChanged = pathname !== prevPathRef.current;
  if (pathChanged) {
    directSidebarPathRef.current = isSidebarNavigation(navigationType, location.state)
      ? pathname
      : null;
  }
  const isDirectSidebarNavigation = directSidebarPathRef.current === pathname;
  const isTabNavigation =
    pathChanged && navigationType === "POP" && historyIndex !== prevHistoryIndexRef.current;
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
  const iptvCustomM3uUrl = useSettingsStore((state) => state.iptvCustomM3uUrl);
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
  const showSiteSwitcher =
    pathname === "/" ||
    pathname.startsWith("/category") ||
    pathname.startsWith("/search") ||
    isFollow ||
    isHistory;
  const showTopNavigation = showSiteSwitcher || isIptv;
  const iptvSourceId = isIptv ? searchParams.get("source") : null;
  const iptvSourceUrl = isIptv ? searchParams.get("m3u") : null;
  const iptvSource = useMemo(
    () => playlistSourceFromRoute(iptvSourceId, iptvSourceUrl ?? iptvCustomM3uUrl),
    [iptvCustomM3uUrl, iptvSourceId, iptvSourceUrl],
  );
  const configuredIptvSource = useMemo(() => {
    const resolved = playlistSourceFromRoute("custom", iptvCustomM3uUrl);
    return resolved.id === "custom" ? resolved : null;
  }, [iptvCustomM3uUrl]);
  const iptvSources = useMemo(() => {
    const sources = [...builtInSources];
    const customSource = configuredIptvSource ?? (iptvSource.id === "custom" ? iptvSource : null);
    if (customSource) sources.push(customSource);
    return sources;
  }, [configuredIptvSource, iptvSource]);
  const iptvSourceOptions = useMemo(() => iptvSources.map((source) => source.id), [iptvSources]);
  const iptvKeyword = isIptv ? (searchParams.get("q") ?? "") : "";
  const rawFollowPlatform = followPlatformFromSearch(searchParams.get(FOLLOW_PLATFORM_PARAM));
  const followPlatform = followPlatformFromSearch(
    searchParams.get(FOLLOW_PLATFORM_PARAM),
    disabledSiteIds,
  );
  const rawHistoryPlatform = historyPlatformFromSearch(searchParams.get(HISTORY_PLATFORM_PARAM));
  const historyPlatform = historyPlatformFromSearch(
    searchParams.get(HISTORY_PLATFORM_PARAM),
    disabledSiteIds,
  );
  const platformForMotion = isFollow ? followPlatform : isHistory ? historyPlatform : activeSiteId;
  const previousPlatformRef = useRef<PlatformScopeValue>(platformForMotion);
  const previousPlatform = previousPlatformRef.current;
  previousPlatformRef.current = platformForMotion;
  // Keyed on the route alone, deliberately. Including the platform here would
  // unmount and rebuild the entire scroller subtree — the grid, the scroll
  // container, everything — during a site switch. Keeping the shell alive lets
  // the query cache replace only the route content.
  const pageMotionKey = pathname;
  // Only history-driven changes animate. Ordinary route pushes replace their
  // content directly so navigation never waits for a decorative entrance.
  const profile = useMemo(() => motionProfile(), []);
  const pageTransitionVariants = useMemo(
    () => tabVariants(profile, tabDirection === "backward" ? -1 : 1),
    [profile, tabDirection],
  );
  const categoryHomePath = categoryHomePathAfterSiteChange(pathname);
  const followPlatforms = useMemo<FollowPlatformFilter[]>(
    () => ["all", ...sitePlatforms],
    [sitePlatforms],
  );
  const historyPlatforms = useMemo<HistoryPlatformFilter[]>(
    () => ["all", ...sitePlatforms],
    [sitePlatforms],
  );
  const platformStrip: readonly PlatformScopeValue[] = isFollow
    ? followPlatforms
    : isHistory
      ? historyPlatforms
      : sitePlatforms;
  const previousPlatformIndex = platformStrip.indexOf(previousPlatform);
  const currentPlatformIndex = platformStrip.indexOf(platformForMotion);
  const platformDirection: "forward" | "backward" =
    currentPlatformIndex >= 0 && previousPlatformIndex >= 0
      ? currentPlatformIndex >= previousPlatformIndex
        ? "forward"
        : "backward"
      : "forward";
  const platformTransitionVariants = useMemo(
    () => tabVariants(profile, platformDirection === "backward" ? -1 : 1),
    [platformDirection, profile],
  );
  const preloadHomePlatform = useCallback(
    (nextSiteId: SiteId | "all") => {
      if (nextSiteId === "all" || pathname !== "/" || nextSiteId === activeSiteId) return;
      prefetchHomeRecommendations(queryClient, nextSiteId);
    },
    [activeSiteId, pathname, queryClient],
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

  const handleHistoryPlatformChange = useCallback(
    (platform: HistoryPlatformFilter) => {
      setSearchParams((current) => withHistoryPlatform(current, platform));
    },
    [setSearchParams],
  );

  const handleIptvSourceChange = useCallback(
    (id: string) => {
      const next = iptvSources.find((source) => source.id === id);
      if (next && next.url !== iptvSource.url) {
        navigate(iptvHomePath({ source: next }));
      }
    },
    [iptvSource.url, iptvSources, navigate],
  );

  const handleIptvSearchChange = useCallback(
    (query: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          const trimmed = query.trim();
          if (trimmed) next.set("q", trimmed);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
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
  const historyPlatformSwipe = useHorizontalSwipe({
    items: historyPlatforms,
    value: historyPlatform,
    onChange: handleHistoryPlatformChange,
    enabled: platformSwipeEnabled && isHistory,
  });
  const iptvSourceSwipe = useHorizontalSwipe({
    items: iptvSourceOptions,
    value: iptvSource.id,
    onChange: handleIptvSourceChange,
    enabled: isIptv && isMobileClient(),
  });
  const platformSwipe = isFollow
    ? followPlatformSwipe
    : isHistory
      ? historyPlatformSwipe
      : sitePlatformSwipe;
  const contentSwipe = isIptv ? iptvSourceSwipe : platformSwipe;

  // A manually opened URL may name a platform that has since been disabled.
  // Keep the page usable on its first render, then remove that stale filter
  // from the address bar without adding a history entry.
  useEffect(() => {
    if (!isFollow || rawFollowPlatform === followPlatform) return;
    setSearchParams((current) => withFollowPlatform(current, followPlatform), { replace: true });
  }, [followPlatform, isFollow, rawFollowPlatform, setSearchParams]);

  useEffect(() => {
    if (!isHistory || rawHistoryPlatform === historyPlatform) return;
    setSearchParams((current) => withHistoryPlatform(current, historyPlatform), { replace: true });
  }, [historyPlatform, isHistory, rawHistoryPlatform, setSearchParams]);

  useEffect(() => {
    if (!isHistory) useHistoryShellStore.getState().reset();
  }, [isHistory]);

  // The scroller used to be keyed by platform, so a site switch reset scrollTop
  // as a side effect of being rebuilt. Now that it persists, do it explicitly:
  // the incoming platform's list is different content, so leaving the viewport
  // parked mid-page would land the user in the middle of rooms they never saw.
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    pageScrollRef.current?.scrollTo({ top: 0 });
  }, [pathname, platformForMotion]);

  const deferRouteOutlet = isDirectSidebarNavigation;
  const routeOutlet = (
    <RouteOutlet
      key={deferRouteOutlet ? pathname : "immediate-route"}
      defer={deferRouteOutlet}
      outlet={outlet}
      platform={platformForMotion}
    />
  );
  const pageScrollerClassName = cn(
    "relative h-full min-h-0",
    // The scroller carries route transforms only for history/in-page motion.
    // Sidebar destinations replace their content directly to avoid mounting
    // both a heavy outgoing and incoming page during one click.
    "overflow-x-hidden overflow-y-auto overscroll-y-contain p-4 pb-[calc(4.75rem+env(safe-area-inset-bottom))] touch-pan-y md:p-5 md:pb-5",
  );
  const swipePage = (
    <m.div
      data-slot="app-swipe-page"
      style={contentSwipe.motionStyle}
      className="relative min-h-full transform-gpu"
    >
      {routeOutlet}
    </m.div>
  );
  const platformPage = (
    <div ref={pageScrollRef} data-slot="app-page" className={pageScrollerClassName}>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.div
          key={`${pathname}:${platformForMotion}`}
          data-slot="cached-platform-page"
          variants={platformTransitionVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="relative min-h-full"
        >
          {swipePage}
        </m.div>
      </AnimatePresence>
    </div>
  );

  return (
    <div className="app-shell flex h-full min-h-0 flex-col bg-background max-md:pt-[env(safe-area-inset-top)]">
      <AppTitleBar />
      <div className="flex min-h-0 min-w-0 flex-1">
        {!isImmersivePlayer && <Sidebar />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <IptvControllerProvider source={iptvSource} active={isIptv}>
            {!isImmersivePlayer && (
              <header
                data-slot="app-header"
                data-mobile-empty={showTopNavigation ? undefined : "true"}
                className={cn(
                  "relative flex h-14 shrink-0 items-center border-b border-border-subtle px-4 max-md:h-12 max-md:gap-2 max-md:px-3",
                  isIptv && "max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto]",
                  !showTopNavigation && "max-md:hidden",
                )}
              >
                {isIptv && (
                  <div className="relative z-10 flex min-w-0 items-center">
                    <IptvHeaderStatusControls />
                  </div>
                )}
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 flex items-center justify-center",
                    !isIptv &&
                      "max-md:relative max-md:inset-auto max-md:min-w-0 max-md:flex-1 max-md:justify-start max-md:overflow-hidden",
                    isIptv &&
                      "max-md:static max-md:inset-auto max-md:min-w-0 max-md:overflow-hidden",
                  )}
                >
                  {showTopNavigation && (
                    <div
                      className={cn(
                        "pointer-events-auto",
                        isIptv ? "max-md:min-w-0 max-md:w-full" : "max-md:min-w-max",
                      )}
                    >
                      {isIptv ? (
                        <div
                          data-horizontal-swipe-surface
                          className="h-full min-w-0"
                          onPointerDownCapture={iptvSourceSwipe.onPointerDownCapture}
                          onPointerMoveCapture={iptvSourceSwipe.onPointerMoveCapture}
                          onPointerUpCapture={iptvSourceSwipe.onPointerUpCapture}
                          onPointerCancelCapture={iptvSourceSwipe.onPointerCancelCapture}
                          onClickCapture={iptvSourceSwipe.onClickCapture}
                        >
                          <IptvSourceSwitcher
                            sources={iptvSources}
                            value={iptvSource.id}
                            onValueChange={handleIptvSourceChange}
                            className="h-full w-40 max-w-full lg:w-auto"
                          />
                        </div>
                      ) : isFollow ? (
                        <SiteSwitcher
                          value={followPlatform}
                          includeAll
                          filterMode
                          onValueChange={handleFollowPlatformChange}
                        />
                      ) : isHistory ? (
                        <SiteSwitcher
                          value={historyPlatform}
                          includeAll
                          filterMode
                          onValueChange={handleHistoryPlatformChange}
                        />
                      ) : (
                        <SiteSwitcher
                          onValueIntent={preloadHomePlatform}
                          onValueChange={(value) => {
                            if (value === "all") return;
                            handleSitePlatformChange(value);
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
                <div
                  className={cn(
                    "relative z-10 ml-auto flex min-w-0 items-center gap-1.5",
                    isIptv && "max-md:ml-0",
                  )}
                >
                  {isIptv ? (
                    <IptvSearchInput
                      keyword={iptvKeyword}
                      onChange={handleIptvSearchChange}
                      className="w-64 max-xl:w-48 max-md:w-[min(9rem,34vw)]"
                    />
                  ) : isHistory ? (
                    <HistoryHeaderControls />
                  ) : (
                    <HeaderSearch />
                  )}
                </div>
              </header>
            )}
            <main
              data-slot="app-content"
              data-immersive={isImmersivePlayer ? "true" : undefined}
              className={cn(
                "relative min-h-0 min-w-0 flex-1",
                // The scroller lives on the animated page wrapper below, not here.
                // A transform contributes to its container's scrollable overflow,
                // so animating a child of an `overflow-auto` element would flash a
                // scrollbar for the length of every transition. Clipping here and
                // scrolling one level down keeps the travel invisible to layout.
                // `relative` gives popLayout a positioning context for the
                // outgoing page, so it cannot displace the incoming one.
                isImmersivePlayer ? "overflow-hidden p-0" : "overflow-hidden",
              )}
              data-horizontal-swipe-surface
              onPointerDownCapture={contentSwipe.onPointerDownCapture}
              onPointerMoveCapture={contentSwipe.onPointerMoveCapture}
              onPointerUpCapture={contentSwipe.onPointerUpCapture}
              onPointerCancelCapture={contentSwipe.onPointerCancelCapture}
              onClickCapture={contentSwipe.onClickCapture}
            >
              {isImmersivePlayer ? (
                // The player owns its own surface and must never be remounted or
                // transformed mid-playback: a transform on an ancestor would make
                // this the containing block for the fullscreen video element.
                <div className={cn("relative h-full min-h-0 overflow-hidden")}>{routeOutlet}</div>
              ) : showSiteSwitcher && !pathChanged && !isTabNavigation ? (
                platformPage
              ) : isDirectSidebarNavigation || !isTabNavigation ? (
                <div ref={pageScrollRef} data-slot="app-page" className={pageScrollerClassName}>
                  {swipePage}
                </div>
              ) : (
                // History navigation keeps the requested left/right page motion.
                <AnimatePresence mode="popLayout" initial={false}>
                  <m.div
                    key={pageMotionKey}
                    ref={pageScrollRef}
                    data-slot="app-page"
                    variants={pageTransitionVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className={pageScrollerClassName}
                  >
                    {swipePage}
                  </m.div>
                </AnimatePresence>
              )}
            </main>
          </IptvControllerProvider>
        </div>
      </div>
    </div>
  );
}
