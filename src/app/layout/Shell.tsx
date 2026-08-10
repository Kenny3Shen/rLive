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
import {
  useLocation,
  useNavigate,
  useNavigationType,
  useOutlet,
  useSearchParams,
} from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Spinner } from "@/components/ui/spinner";
import { IptvSearchInput, IptvSourceSwitcher } from "@/features/iptv/IptvHeaderControls";
import { IptvControllerProvider } from "@/features/iptv/IptvController";
import { iptvHomePath } from "@/features/iptv/iptvRoute";
import { builtInSources, playlistSourceFromRoute } from "@/features/iptv/playlistSource";
import { HistoryClearButton, HistoryViewSwitcher } from "@/features/history/HistoryHeaderControls";
import { useHistoryHeaderSnapshot } from "@/features/history/historyHeaderState";
import { SiteSwitcher } from "@/shared/components/SiteSwitcher";
import { HeaderSearch } from "@/shared/components/HeaderSearch";
import { RefreshFabVisibilityProvider } from "@/shared/components/RefreshFab";
import { categoryHomePathAfterSiteChange } from "@/features/category/categoryRoute";
import {
  FOLLOW_PLATFORM_PARAM,
  FOLLOW_VIEW_PARAM,
  type FollowPlatformFilter,
  followPlatformFromSearch,
  followViewFromSearch,
  withFollowPlatform,
} from "@/features/follow/followRoute";
import {
  FOLLOW_IPTV_GROUP_PARAM,
  FOLLOW_IPTV_SOURCE_PARAM,
  withIptvFollowSource,
} from "@/features/follow/iptvFollowGroups";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import { PagePan } from "@/shared/motion/PagePan";
import { PageZoom } from "@/shared/motion/PageZoom";
import { isMobileClient } from "@/shared/clientPlatform";
import { enabledSiteIds } from "@/shared/siteId";
import { PlatformScope, type PlatformScopeValue } from "@/shared/hooks/useSiteQuery";
import type { SiteId } from "@/shared/types/live";
import { Sidebar } from "./Sidebar";
import { AppTitleBar } from "./AppTitleBar";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn } from "@/lib/utils";
import {
  isSidebarNavigation,
  routeScopedPreviousGroup,
  sidebarNavigationDirection,
} from "./sidebarNavigation";
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

    // Let the compositor start the page pan before React mounts the new route.
    // A transition render can yield when the destination contains a large list.
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
  const isMultiRoom = pathname === "/multi-room";
  const isIptv = pathname === "/iptv";
  const isIptvPlayer = pathname === "/iptv/play";
  const isImmersivePlayer = isRoom || isIptvPlayer || isMultiRoom;
  const isFollow = pathname === "/follow";
  const isHistory = pathname === "/history";
  const isSettings = pathname === "/settings";
  const mobileClient = isMobileClient();
  const historyHeader = useHistoryHeaderSnapshot();

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
  const sidebarDirectionRef = useRef<1 | -1>(1);
  const tabNavigationRef = useRef<{
    pathname: string;
    direction: "forward" | "backward";
  } | null>(null);
  const pathChanged = pathname !== prevPathRef.current;
  if (pathChanged) {
    const directSidebarNavigation = isSidebarNavigation(navigationType, location.state);
    directSidebarPathRef.current = directSidebarNavigation ? pathname : null;
    if (directSidebarNavigation) {
      sidebarDirectionRef.current = sidebarNavigationDirection(prevPathRef.current, pathname);
    }
    const tabDirection =
      navigationType === "POP" && historyIndex !== prevHistoryIndexRef.current
        ? historyIndex > prevHistoryIndexRef.current
          ? "forward"
          : "backward"
        : null;
    tabNavigationRef.current = tabDirection ? { pathname, direction: tabDirection } : null;
  }
  const isDirectSidebarNavigation = directSidebarPathRef.current === pathname;
  const tabNavigation = tabNavigationRef.current;
  const isTabNavigation = tabNavigation?.pathname === pathname;
  const tabDirection = isTabNavigation ? tabNavigation.direction : null;
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
  const followView = followViewFromSearch(searchParams.get(FOLLOW_VIEW_PARAM));
  const isLiveFollow = isFollow && followView === "live";
  const isIptvFollow = isFollow && followView === "iptv";
  const hasIptvSourceShell = isIptv || isIptvFollow;
  const iptvFollowGroup = isIptvFollow ? searchParams.get(FOLLOW_IPTV_GROUP_PARAM) : null;
  // Routes carrying the live-platform strip. This gates the platform swipe and
  // the `SiteSwitcher` itself, so IPTV must stay out of it: IPTV has its own
  // source strip and its own swipe.
  const showSiteSwitcher =
    pathname === "/" ||
    pathname.startsWith("/category") ||
    pathname.startsWith("/search") ||
    isLiveFollow;
  // Keep both follow views in the same content container so changing the
  // live/IPTV tab does not remount FollowPage and discard its transition state.
  // IPTV follow groups animate inside IptvFollowView rather than in this layer.
  const useGroupedPageContainer = showSiteSwitcher || isIptv || isIptvFollow;
  const showTopNavigation = useGroupedPageContainer || isHistory;
  const iptvSourceId = hasIptvSourceShell ? searchParams.get(FOLLOW_IPTV_SOURCE_PARAM) : null;
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
  const platformForMotion = isFollow ? followPlatform : activeSiteId;
  // The grouping a page pans between. Live routes travel between platforms;
  // IPTV travels between playlist sources. Both are the same gesture and the
  // same header slot, so they share one pan rather than each owning a scheme.
  const groupForMotion: string = isIptv ? iptvSource.id : String(platformForMotion);
  const previousGroupRef = useRef({ pathname, group: groupForMotion });
  const previousGroup = routeScopedPreviousGroup(
    previousGroupRef.current.pathname,
    previousGroupRef.current.group,
    pathname,
    groupForMotion,
  );
  previousGroupRef.current = { pathname, group: groupForMotion };
  // Keyed on the route alone, deliberately. Including the platform here would
  // unmount and rebuild the entire scroller subtree — the grid, the scroll
  // container, everything — during a site switch. Keeping the shell alive lets
  // the query cache replace only the route content.
  const pageMotionKey = pathname;
  const categoryHomePath = categoryHomePathAfterSiteChange(pathname);
  const followPlatforms = useMemo<FollowPlatformFilter[]>(
    () => ["all", ...sitePlatforms],
    [sitePlatforms],
  );
  const platformStrip: readonly PlatformScopeValue[] = isLiveFollow
    ? followPlatforms
    : sitePlatforms;
  // One ordered strip per surface, compared as strings so platforms and IPTV
  // source ids share the same direction rule.
  const groupStrip: readonly string[] = isIptv ? iptvSourceOptions : platformStrip.map(String);
  const previousGroupIndex = groupStrip.indexOf(previousGroup);
  const currentGroupIndex = groupStrip.indexOf(groupForMotion);
  const groupDirection: "forward" | "backward" =
    currentGroupIndex >= 0 && previousGroupIndex >= 0
      ? currentGroupIndex >= previousGroupIndex
        ? "forward"
        : "backward"
      : "forward";
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

  const handleIptvSourceChange = useCallback(
    (id: string) => {
      const next = iptvSources.find((source) => source.id === id);
      if (next && next.url !== iptvSource.url) {
        if (isIptvFollow) {
          setSearchParams((current) => withIptvFollowSource(current, next.id));
        } else {
          navigate(iptvHomePath({ source: next }));
        }
      }
    },
    [iptvSource.url, iptvSources, isIptvFollow, navigate, setSearchParams],
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
  // History owns a nested two-page strip (watch / sent danmaku). Its platform
  // filter remains tappable in the header, but the surrounding Shell must not
  // compete for the same horizontal gesture.
  const platformSwipeEnabled = showSiteSwitcher && mobileClient && !isHistory;
  // `track` is the layout `liveSwipePage` below renders: every mounted platform
  // sits at its own absolute index, so the gesture pans a layer whose
  // neighbouring pages are already painted and selecting one moves none of them.
  // Every other surface binds these hooks to the single-page `swipePage` instead.
  const platformSwipeLayout = platformSwipeEnabled ? "track" : "page";
  const sitePlatformSwipe = useHorizontalSwipe({
    items: sitePlatforms,
    value: activeSiteId,
    onChange: handleSitePlatformChange,
    enabled: platformSwipeEnabled && !isLiveFollow,
    animate: platformSwipeEnabled,
    layout: platformSwipeLayout,
  });
  const followPlatformSwipe = useHorizontalSwipe({
    items: followPlatforms,
    value: followPlatform,
    onChange: handleFollowPlatformChange,
    enabled: platformSwipeEnabled && isLiveFollow,
    animate: platformSwipeEnabled,
    layout: platformSwipeLayout,
  });
  const iptvSourceSwipe = useHorizontalSwipe({
    items: iptvSourceOptions,
    value: iptvSource.id,
    onChange: handleIptvSourceChange,
    enabled: isIptv && mobileClient,
  });
  const platformSwipe = isLiveFollow ? followPlatformSwipe : sitePlatformSwipe;
  const contentSwipe = isIptv ? iptvSourceSwipe : platformSwipe;
  const contentSwipePageRef = contentSwipe.pageRef;
  const bindContentSwipePageRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      contentSwipePageRef.current = node;
      return () => {
        if (contentSwipePageRef.current === node) contentSwipePageRef.current = null;
      };
    },
    [contentSwipePageRef],
  );

  // A manually opened URL may name a platform that has since been disabled.
  // Keep the page usable on its first render, then remove that stale filter
  // from the address bar without adding a history entry.
  useEffect(() => {
    if (!isFollow || rawFollowPlatform === followPlatform) return;
    setSearchParams((current) => withFollowPlatform(current, followPlatform), { replace: true });
  }, [followPlatform, isFollow, rawFollowPlatform, setSearchParams]);

  // The scroller used to be keyed by platform, so a site switch reset scrollTop
  // as a side effect of being rebuilt. Now that it persists, do it explicitly:
  // the incoming platform's list is different content, so leaving the viewport
  // parked mid-page would land the user in the middle of rooms they never saw.
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const bindPageScrollRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    pageScrollRef.current = node;
    return () => {
      if (pageScrollRef.current === node) pageScrollRef.current = null;
    };
  }, []);
  useEffect(() => {
    pageScrollRef.current?.scrollTo({ top: 0 });
  }, [iptvFollowGroup, iptvSource.id, pathname, platformForMotion]);

  // Mobile bottom navigation swaps pages atomically. Retaining the outgoing
  // ReactNode made its last selected platform visible for one compositor frame
  // when the exit layer was removed. Desktop keeps the directional page pan.
  const deferRouteOutlet = isDirectSidebarNavigation && !mobileClient;
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
    // The scroller stays inside the compositor-only page wrapper so translated
    // content cannot enlarge the main pane or flash a second scrollbar.
    "overflow-x-hidden overflow-y-auto overscroll-y-contain p-4 pb-[calc(4.25rem+env(safe-area-inset-bottom))] touch-pan-y md:p-5 md:pb-5",
  );
  const swipePage = (
    <div
      ref={bindContentSwipePageRef}
      data-slot="app-swipe-page"
      className="relative h-full min-h-full"
    >
      {routeOutlet}
    </div>
  );
  const groupPage = (
    <div ref={bindPageScrollRef} data-slot="app-page" className={pageScrollerClassName}>
      <PagePan
        panKey={groupForMotion}
        direction={groupDirection === "backward" ? -1 : 1}
        className="min-h-full"
      >
        {swipePage}
      </PagePan>
    </div>
  );
  const activeLivePanelIndex = platformStrip.indexOf(platformForMotion);
  const liveSwipePanels: PlatformScopeValue[] = [];
  const addLiveSwipePanel = (index: number) => {
    const platform = platformStrip[index];
    if (platform !== undefined && !liveSwipePanels.includes(platform)) {
      liveSwipePanels.push(platform);
    }
  };
  addLiveSwipePanel(activeLivePanelIndex - 1);
  addLiveSwipePanel(activeLivePanelIndex);
  addLiveSwipePanel(activeLivePanelIndex + 1);
  const previousLivePanelIndex = platformStrip.findIndex(
    (platform) => String(platform) === previousGroup,
  );
  if (previousGroup !== groupForMotion) addLiveSwipePanel(previousLivePanelIndex);
  liveSwipePanels.sort((left, right) => platformStrip.indexOf(left) - platformStrip.indexOf(right));

  const liveSwipePage = (
    // The rendered window is the active platform plus its neighbours. The track
    // holds them side by side and travels as one layer, so the incoming page is
    // already painted and enters continuously under the finger instead of
    // appearing only once the gesture is released. Each panel keeps its own
    // scroller, so they are positioned rather than laid out in a flex row.
    //
    // Each panel sits at its *absolute* strip index and the track is translated
    // to -activeIndex * width. Positioning them relative to the active index
    // instead would shift every panel by a full width the moment a swipe
    // commits, forcing the release to be rebased around that jump — the extra
    // step that made a committed swipe read as a switch followed by a slide.
    <div data-slot="app-swipe-viewport" className="relative h-full min-h-0 min-w-0 overflow-hidden">
      <div
        ref={bindContentSwipePageRef}
        data-slot="app-swipe-track"
        className="relative h-full min-h-0 min-w-0"
      >
        {liveSwipePanels.map((platform) => {
          const panelIndex = platformStrip.indexOf(platform);
          const panelOffset = panelIndex * 100;
          const active = panelIndex === activeLivePanelIndex;
          return (
            <div
              key={String(platform)}
              ref={active ? bindPageScrollRef : undefined}
              data-slot="app-swipe-panel"
              aria-hidden={active ? undefined : true}
              inert={active ? undefined : true}
              className={cn(pageScrollerClassName, "absolute inset-0 w-full")}
              style={{ transform: `translate3d(${panelOffset}%, 0, 0)` }}
            >
              <RefreshFabVisibilityProvider visible={active}>
                <RouteOutlet
                  defer={active && deferRouteOutlet}
                  outlet={outlet}
                  platform={platform}
                />
              </RefreshFabVisibilityProvider>
            </div>
          );
        })}
      </div>
    </div>
  );
  const regularPage =
    mobileClient && showSiteSwitcher && !isHistory ? (
      liveSwipePage
    ) : useGroupedPageContainer ? (
      groupPage
    ) : (
      <div ref={bindPageScrollRef} data-slot="app-page" className={pageScrollerClassName}>
        {swipePage}
      </div>
    );
  const routePanDirection = isDirectSidebarNavigation
    ? sidebarDirectionRef.current
    : tabDirection === "backward"
      ? -1
      : 1;
  const routePanAxis = isDirectSidebarNavigation && !mobileClient ? "vertical" : "horizontal";
  const routePanEnabled = !mobileClient && (isDirectSidebarNavigation || isTabNavigation);

  return (
    <div className="app-shell flex h-full min-h-0 flex-col bg-background max-md:pt-[env(safe-area-inset-top)]">
      <AppTitleBar />
      <PageZoom
        // Both immersive players zoom, each keyed on its own pathname so a
        // room and the IPTV player are never collapsed into one page — that
        // shared key, not the zoom itself, was the thing to avoid.
        zoomKey={isImmersivePlayer ? pathname : "standard-shell"}
        enabled={isImmersivePlayer}
        className="flex-1 overflow-hidden"
      >
        <div className="flex min-h-0 min-w-0 flex-1">
          {!isImmersivePlayer && <Sidebar />}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <IptvControllerProvider source={iptvSource} active={isIptv}>
              {!isImmersivePlayer && !isSettings && (
                <header
                  data-slot="app-header"
                  data-mobile-empty={showTopNavigation ? undefined : "true"}
                  className={cn(
                    "relative flex h-14 shrink-0 items-center border-b border-border-subtle px-4 max-md:h-12 max-md:gap-2 max-md:px-3",
                    isIptv && "max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto]",
                    !showTopNavigation && "max-md:hidden",
                  )}
                >
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-0 flex items-center justify-center",
                      !hasIptvSourceShell &&
                        "max-md:relative max-md:inset-auto max-md:min-w-0 max-md:flex-1 max-md:justify-start max-md:overflow-hidden",
                      hasIptvSourceShell &&
                        "max-md:static max-md:inset-auto max-md:min-w-0 max-md:flex-1 max-md:overflow-hidden",
                    )}
                  >
                    {showTopNavigation && (
                      <div
                        className={cn(
                          "pointer-events-auto",
                          hasIptvSourceShell ? "max-md:min-w-0 max-md:w-full" : "max-md:min-w-max",
                        )}
                      >
                        {isHistory ? (
                          <HistoryViewSwitcher
                            value={historyHeader.view}
                            onValueChange={historyHeader.onViewChange}
                          />
                        ) : hasIptvSourceShell ? (
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
                              className={cn(
                                "h-full max-w-full lg:w-auto",
                                isIptv ? "w-40 max-md:w-36" : "w-44 max-md:w-full",
                              )}
                            />
                          </div>
                        ) : isFollow ? (
                          <SiteSwitcher
                            value={followPlatform}
                            includeAll
                            filterMode
                            onValueChange={handleFollowPlatformChange}
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
                        className="w-64 max-xl:w-48 max-md:w-[min(11rem,43vw)]"
                      />
                    ) : isHistory ? (
                      <HistoryClearButton
                        view={historyHeader.view}
                        canClear={historyHeader.canClear}
                        pending={historyHeader.clearPending}
                        onRequestClear={historyHeader.onRequestClear}
                      />
                    ) : isIptvFollow ? null : (
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
                  // PageZoom clears its compositor hints after entering. The
                  // settled player therefore has no transformed ancestor that
                  // could interfere with its fullscreen containing block.
                  <div className="relative h-full min-h-0 overflow-hidden">{routeOutlet}</div>
                ) : (
                  <PagePan
                    panKey={pageMotionKey}
                    direction={routePanDirection}
                    axis={routePanAxis}
                    enabled={routePanEnabled}
                    className="h-full min-h-0"
                    contentClassName="h-full min-h-0"
                  >
                    {regularPage}
                  </PagePan>
                )}
              </main>
            </IptvControllerProvider>
          </div>
        </div>
      </PageZoom>
    </div>
  );
}
