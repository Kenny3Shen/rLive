import {
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft } from "lucide-react";
import {
  useLocation,
  useNavigate,
  useNavigationType,
  useOutlet,
  useSearchParams,
} from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { IptvSourceSwitcher } from "@/features/iptv/IptvHeaderControls";
import { IptvControllerProvider } from "@/features/iptv/IptvController";
import { iptvHomePath } from "@/features/iptv/iptvRoute";
import {
  playlistSourceFromRoute,
  playlistSourcesForSettings,
} from "@/features/iptv/playlistSource";
import { HistoryClearButton, HistoryViewSwitcher } from "@/features/history/HistoryHeaderControls";
import { useHistoryHeaderSnapshot } from "@/features/history/historyHeaderState";
import { FollowViewSwitcher } from "@/features/follow/FollowHeaderControls";
import { useFollowHeaderSnapshot } from "@/features/follow/followHeaderState";
import {
  RecordingStorageButton,
  RecordingViewSwitcher,
} from "@/features/recording/RecordingHeaderControls";
import { recordingSupported } from "@/features/recording/recording";
import { useRecordingHeaderSnapshot } from "@/features/recording/recordingHeaderState";
import { CATEGORY_BROWSE_PATH } from "@/features/category/categorySelection";
import { canNavigateBackInApp } from "@/shared/appHistory";
import { SiteSwitcher } from "@/shared/components/SiteSwitcher";
import { HeaderSearch } from "@/shared/components/HeaderSearch";
import { RefreshFabVisibilityProvider } from "@/shared/components/RefreshFab";
import {
  FOLLOW_PLATFORM_PARAM,
  FOLLOW_VIEW_PARAM,
  followPlatformFromSearch,
  followViewFromSearch,
} from "@/features/follow/followRoute";
import {
  FOLLOW_IPTV_GROUP_PARAM,
  FOLLOW_IPTV_SOURCE_PARAM,
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
import { isImmersivePlayerPath } from "./immersiveRoutes";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn } from "@/lib/utils";
import {
  isSidebarNavigation,
  routeScopedPreviousGroup,
  sidebarNavigationDirection,
} from "./sidebarNavigation";
import {
  PAGE_SCROLL_ANCHOR_STABLE_FRAMES,
  PAGE_SCROLL_RESTORE_MAX_FRAMES,
  beginPageScrollRestore,
  nextPageScrollAnchorStableFrames,
  pageScrollKey,
  pageScrollRestoreSettled,
  pageScrollTargetForAnchor,
  recallPageScrollSnapshot,
  rememberPageScroll,
  rememberPageScrollAnchor,
  shouldRestorePageScroll,
} from "./pageScroll";
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

    // 让合成器在 React 挂载新路由之前就开始页面平移。
    // 目标页包含大列表时，过渡渲染可能发生让步。
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
  const [searchParams] = useSearchParams();
  const isIptv = pathname === "/iptv";
  const isImmersivePlayer = isImmersivePlayerPath(pathname);
  const isSearch = pathname === "/search";
  const isCategoryBrowse = pathname === CATEGORY_BROWSE_PATH;
  const isFollow = pathname === "/follow";
  const isHistory = pathname === "/history";
  // 录制仅限桌面端，因此移动端深链接保持普通头部加上页面自己的
  // "仅支持桌面端"状态，而不是空白的作用域页签。
  const isRecordings = pathname === "/recordings" && recordingSupported();
  const isSettings = pathname === "/settings";
  const mobileClient = isMobileClient();
  const historyHeader = useHistoryHeaderSnapshot();
  const followHeader = useFollowHeaderSnapshot();
  const recordingHeader = useRecordingHeaderSnapshot();

  // React Router 用递增的 `idx` 记录每条 pushState 历史。跨渲染比较它可以告诉
  // 页签切换用户在历史中向哪个方向移动，从而让新页面从相应的一侧滑入。
  // 在渲染期间幂等地写入，refs 只是镜像最后一次视图。
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
  const isIptvFollow = isFollow && followView === "iptv";
  const hasIptvSourceShell = isIptv;
  const iptvFollowGroup = isIptvFollow ? searchParams.get(FOLLOW_IPTV_GROUP_PARAM) : null;
  // 携带直播平台条的各路由。关注拥有独立的顶层 直播/IPTV 页签，
  // 并把平台过滤保留在页面侧栏内部。
  // 分类页也在列：分区 id 属于具体平台，没有平台条就无法在那一屏里换平台看分区。
  const showSiteSwitcher = pathname === "/" || isCategoryBrowse || pathname.startsWith("/search");
  // 两个关注视图共用同一个内容容器，切换 直播/IPTV 页签时不会重新挂载
  // FollowPage、丢失其过渡状态。IPTV 关注分组的动画
  // 发生在 IptvFollowView 内部而不是这一层。
  const useGroupedPageContainer = showSiteSwitcher || isFollow || isIptv;
  const showTopNavigation = useGroupedPageContainer || isHistory || isRecordings;
  const iptvSourceId = isIptv || isIptvFollow ? searchParams.get(FOLLOW_IPTV_SOURCE_PARAM) : null;
  const iptvSourceUrl = isIptv ? searchParams.get("m3u") : null;
  const iptvSource = useMemo(
    () => playlistSourceFromRoute(iptvSourceId, iptvSourceUrl ?? iptvCustomM3uUrl),
    [iptvCustomM3uUrl, iptvSourceId, iptvSourceUrl],
  );
  const iptvSources = useMemo(() => {
    const sources = playlistSourcesForSettings(iptvCustomM3uUrl);
    if (iptvSource.id === "custom" && !sources.some((source) => source.id === "custom")) {
      sources.push(iptvSource);
    }
    return sources;
  }, [iptvCustomM3uUrl, iptvSource]);
  const iptvSourceOptions = useMemo(() => iptvSources.map((source) => source.id), [iptvSources]);
  const followPlatform = followPlatformFromSearch(
    searchParams.get(FOLLOW_PLATFORM_PARAM),
    disabledSiteIds,
  );
  const platformForMotion = isFollow ? followPlatform : activeSiteId;
  // 页面平移所跨越的分组。直播路由在平台之间移动；
  // IPTV 在播放列表来源之间移动。两者是同一种手势、同一个头部槽位，
  // 因此共享一次平移，而不是各自维护一套方案。
  const groupForMotion: string = isIptv ? iptvSource.id : String(platformForMotion);
  const previousGroupRef = useRef({ pathname, group: groupForMotion });
  const previousGroup = routeScopedPreviousGroup(
    previousGroupRef.current.pathname,
    previousGroupRef.current.group,
    pathname,
    groupForMotion,
  );
  previousGroupRef.current = { pathname, group: groupForMotion };
  // 刻意只按路由作为 key。如果在这里加入平台，站点切换时会卸载并重建整个
  // 滚动子树 —— 网格、滚动容器，全部。保持外壳存活，
  // 查询缓存就能只替换路由内容。
  const pageMotionKey = pathname;
  const platformStrip: readonly PlatformScopeValue[] = sitePlatforms;
  // 每个表面一条有序条带，按字符串比较，
  // 使平台 id 与 IPTV 来源 id 共用同一个方向规则。
  const groupStrip: readonly string[] = isIptv
    ? iptvSourceOptions
    : isFollow
      ? ["all", ...sitePlatforms]
      : platformStrip.map(String);
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
    },
    // 首页的分区选择不需要在这里清理：`?cat=` 自带 siteId，切平台后新平台的面板
    // 解析不到属于自己的选择，自然回落推荐态，切回去时原选择还在。
    [activeSiteId, setSiteId],
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

  const goBackToDiscovery = useCallback(() => {
    if (canNavigateBackInApp(window.history.state)) {
      navigate(-1);
      return;
    }
    navigate("/", { replace: true });
  }, [navigate]);

  // 首页/分类/搜索用横向内容滑动切换平台。关注和历史拥有自己嵌套的页签条，
  // Shell 不与这些路由争夺横向手势。
  const platformSwipeEnabled = showSiteSwitcher && mobileClient && !isHistory;
  // `track` 就是下面 `liveSwipePage` 渲染的布局：每个已挂载的平台都位于各自的
  // 绝对下标处，手势平移的这一层的相邻页面已经绘制完成，
  // 选中任何一个都不会带动其他页面移动。
  // 其余表面把这些 hooks 绑定到单页版的 `swipePage` 上。
  const platformSwipeLayout = platformSwipeEnabled ? "track" : "page";
  const sitePlatformSwipe = useHorizontalSwipe({
    items: sitePlatforms,
    value: activeSiteId,
    onChange: handleSitePlatformChange,
    enabled: platformSwipeEnabled,
    animate: platformSwipeEnabled,
    layout: platformSwipeLayout,
  });
  const iptvSourceSwipe = useHorizontalSwipe({
    items: iptvSourceOptions,
    value: iptvSource.id,
    onChange: handleIptvSourceChange,
    enabled: isIptv && mobileClient,
  });
  const contentSwipe = isIptv ? iptvSourceSwipe : sitePlatformSwipe;
  // `PagePan` 以 pathname 为 key，回到可滑动路由时 hook 会拿到全新的 track。
  // 通过 `bindPage` 绑定才能把它重新停靠到活动平台的偏移处 ——
  // 直接赋值 `pageRef` 会让新 track 保持未变换状态，
  // 把第一个之后的所有面板推到屏幕外，
  // 连页面的滚动容器一起带走。
  const bindContentSwipePageRef = contentSwipe.bindPage;

  // 滚动容器过去以 platform 为 key，站点切换会因为重建而顺带重置 scrollTop。
  // 既然现在它能存活，位置就改为显式管理：
  // 切到不同内容仍从顶部开始，
  // 而回到用户已经滚动过的页面则回放其离开时的位置。
  //
  // `location.key` 对每条历史记录稳定，因此记住的位置能挺过完全卸载此滚动器的
  // 房间访问。key 的其余部分覆盖旧重置逻辑观察的内容：
  // 同一历史下，两个平台或两个 IPTV 来源属于不同内容。
  const surfaceKey = pageScrollKey(
    location.key,
    `${pathname}|${platformForMotion}|${iptvSource.id}`,
    iptvFollowGroup,
  );
  // 由下方的 scroll 监听读取，监听器的寿命超过任何单次渲染。
  // 在渲染期间幂等写入，使其永远不会落后于已提交的表面。
  const surfaceKeyRef = useRef(surfaceKey);
  surfaceKeyRef.current = surfaceKey;
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const bindPageScrollRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    pageScrollRef.current = node;
    // 每次滚动同步记录，而不是在卸载时统一冲刷。清理阶段的读取会运行在下方布局
    // 副作用*之后* —— 那时离开表面已被重置为 0，存下的将是这次重置而非用户
    // 停留的位置。每个 scroll 事件写一个 Map 条目开销很低，
    // 且 `scrollTop` 本来就要在滚动处理器内解析。
    const onScroll = () => rememberPageScroll(surfaceKeyRef.current, node.scrollTop);
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLElement>("[data-page-scroll-anchor]");
      const anchorKey = anchor?.dataset.pageScrollAnchor;
      if (!anchor || !anchorKey || !node.contains(anchor)) return;

      const viewportOffset = anchor.getBoundingClientRect().top - node.getBoundingClientRect().top;
      rememberPageScrollAnchor(surfaceKeyRef.current, node.scrollTop, anchorKey, viewportOffset);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("click", onClick, { capture: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("click", onClick, { capture: true });
      if (pageScrollRef.current === node) pageScrollRef.current = null;
    };
  }, []);
  const previousSurfaceKeyRef = useRef(surfaceKey);
  const previousEntryKeyRef = useRef(location.key);
  useLayoutEffect(() => {
    const previousSurfaceKey = previousSurfaceKeyRef.current;
    const previousEntryKey = previousEntryKeyRef.current;
    previousSurfaceKeyRef.current = surfaceKey;
    previousEntryKeyRef.current = location.key;
    if (previousSurfaceKey === surfaceKey) return;

    const scroller = pageScrollRef.current;
    if (!scroller) return;

    const restore = shouldRestorePageScroll({
      navigationType,
      previousEntryKey,
      entryKey: location.key,
      previousSurfaceKey,
      surfaceKey,
    });
    const snapshot = restore ? recallPageScrollSnapshot(surfaceKey) : { top: 0, anchor: null };

    if (snapshot.top <= 0 && snapshot.anchor === null) {
      scroller.scrollTo({ top: 0 });
      return;
    }

    // 无限列表在其行完成布局之前就被恢复，第一次赋值会被钳制到当前存在的高度。
    // 跨帧重复应用，直到内容高到足以容纳偏移量。`target` 在这里捕获，
    // 因此这些写入记录的被钳制位置不会缩短最终目标。
    //
    // 那些写入仍会触发 `scroll`，上方监听器会把被钳制的偏移盖过正在回放的位置。
    // 在恢复持续期间抑制对该表面的记录：当列表花掉超过一帧预算才达到完整高度时，
    // 记忆得以保全，之后再访问同一历史仍从用户真实所在处回放，
    // 而不是上次尝试到达的距离。
    const endRestore = beginPageScrollRestore(surfaceKey);
    let frame: number | null = null;
    let remaining = PAGE_SCROLL_RESTORE_MAX_FRAMES;
    let anchorElement: HTMLElement | null = null;
    let anchorStableFrames = 0;
    let previousAnchorScrollHeight: number | null = null;
    // `scroll` 在引发它的赋值之后派发，所以守卫要比最后一次写入多活一帧。
    // 同步释放会让最后一个被钳制的事件漏过去 —— 这恰是守卫要防的情况。
    const finish = () => {
      frame = window.requestAnimationFrame(() => {
        frame = null;
        endRestore();
      });
    };
    const apply = () => {
      frame = null;
      let target = snapshot.top;
      let anchorResolved = snapshot.anchor === null;
      let anchorSettled = false;
      if (snapshot.anchor !== null) {
        if (!anchorElement?.isConnected) {
          anchorElement =
            Array.from(scroller.querySelectorAll<HTMLElement>("[data-page-scroll-anchor]")).find(
              (element) => element.dataset.pageScrollAnchor === snapshot.anchor?.key,
            ) ?? null;
        }
        if (anchorElement) {
          const currentViewportOffset =
            anchorElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          anchorStableFrames = nextPageScrollAnchorStableFrames(
            currentViewportOffset,
            snapshot.anchor.viewportOffset,
            scroller.scrollHeight,
            previousAnchorScrollHeight,
            anchorStableFrames,
          );
          previousAnchorScrollHeight = scroller.scrollHeight;
          target = pageScrollTargetForAnchor(
            scroller.scrollTop,
            currentViewportOffset,
            snapshot.anchor.viewportOffset,
          );
          anchorResolved = true;
          anchorSettled = anchorStableFrames >= PAGE_SCROLL_ANCHOR_STABLE_FRAMES;
        } else {
          anchorStableFrames = 0;
          previousAnchorScrollHeight = scroller.scrollHeight;
        }
      }
      scroller.scrollTop = target;
      if (
        (snapshot.anchor === null && pageScrollRestoreSettled(scroller.scrollTop, target)) ||
        (anchorResolved && anchorSettled) ||
        remaining <= 0
      ) {
        finish();
        return;
      }
      remaining -= 1;
      frame = window.requestAnimationFrame(apply);
    };
    apply();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      endRestore();
    };
  }, [location.key, navigationType, surfaceKey]);

  // 移动端底部导航原子式换页。保留离场的 ReactNode 曾让它最后选中的平台在退出
  // 层移除时多显示一个合成帧。桌面端保留方向性页面平移。
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
    // 滚动容器留在仅合成的页面包装层内部，
    // 使被位移的内容无法撑大主面板或闪出第二条滚动条。
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
    // 渲染窗口是活动平台加其邻居。track 让它们并排存在并作为一个整体移动，
    // 因此进入的页面已经绘制完成，能在手指之下连续进入，
    // 而不是在手势释放后才出现。每个面板保留自己的滚动容器，
    // 它们是被定位的，不是 flex 行内布局。
    //
    // 每个面板位于其*绝对*条带下标处，track 平移 -activeIndex * width。
    // 若改为相对活动下标定位，滑动提交的那一刻所有面板都会整体移动一个宽度，
    // 迫使释放动作围绕这次跳变重新基准化 —— 正是这个多余步骤让已提交的滑动
    // 看起来像先切换了一次再滑了一段。
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
        // 两个沉浸播放器各自缩放，且都以自己的 pathname 为 key，
        // 使房间与 IPTV 播放器绝不会被合并成同一页 ——
        // 需要避免的是那个共享 key，而不是缩放本身。
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
                    !showTopNavigation && "max-md:hidden",
                  )}
                >
                  {/* 搜索与「全部分类」都是从别处 push 出来的取向表面，侧栏里没有对应
                      条目可点回去，所以头部给一个显式返回口。 */}
                  {(isSearch || isCategoryBrowse) && (
                    <div className="relative z-10 flex shrink-0 items-center max-md:hidden">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="返回上一页"
                        title="返回上一页"
                        onClick={goBackToDiscovery}
                      >
                        <ArrowLeft aria-hidden />
                      </Button>
                    </div>
                  )}
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-0 flex h-full items-center justify-center",
                      "max-md:relative max-md:inset-auto max-md:min-w-0 max-md:flex-1 max-md:justify-start max-md:overflow-hidden",
                    )}
                  >
                    {showTopNavigation && (
                      <div className="pointer-events-auto h-full max-md:w-full max-md:min-w-0">
                        {isHistory ? (
                          <HistoryViewSwitcher
                            value={historyHeader.view}
                            onValueChange={historyHeader.onViewChange}
                          />
                        ) : isRecordings ? (
                          <RecordingViewSwitcher
                            value={recordingHeader.view}
                            counts={recordingHeader.counts}
                            onValueChange={recordingHeader.onViewChange}
                          />
                        ) : isFollow ? (
                          <FollowViewSwitcher
                            value={followHeader.view}
                            onValueChange={followHeader.onViewChange}
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
                              className="h-full w-auto max-w-full max-md:w-full"
                            />
                          </div>
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
                  <div className="relative z-10 ml-auto flex min-w-0 items-center gap-1.5">
                    {isHistory ? (
                      <HistoryClearButton
                        view={historyHeader.view}
                        canClear={historyHeader.canClear}
                        pending={historyHeader.clearPending}
                        onRequestClear={historyHeader.onRequestClear}
                      />
                    ) : isRecordings ? (
                      <RecordingStorageButton onRequestStorage={recordingHeader.onRequestStorage} />
                    ) : isFollow || isIptv ? null : (
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
                  // 滚动容器位于下方带动画的页面包装层上，而不是这里。transform 会参与其容器
                  // 的可滚动溢出计算，因此对 `overflow-auto` 元素的子元素做动画，
                  // 会在每次过渡期间闪出滚动条。在这一层裁剪、下一层滚动，
                  // 让移动过程对布局不可见。`relative` 为 popLayout 提供离场页面的定位上下文，
                  // 使其无法挤动进入的页面。
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
                  // PageZoom 进入后会清除它的合成提示。稳定下来的播放器因此没有
                  // 可能干扰其全屏包含块的已变换祖先。
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
