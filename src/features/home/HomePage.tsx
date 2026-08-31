import { memo, useMemo, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Loader2, Radio, Sparkles } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { invokeCmd } from "@/shared/api/tauri";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { isMobileClient } from "@/shared/clientPlatform";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { RoomCard } from "@/shared/components/RoomCard";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type { LiveCategory, LiveRoomItem, LiveSubCategory } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { SITE_LABELS } from "@/lib/utils";
import { preloadRouteModule } from "@/app/routeModules";
import { CategoryBar } from "@/features/category/CategoryBar";
import { CategoryPanel } from "@/features/category/CategoryPanel";
import { categoryRoomsQueryOptions } from "@/features/category/categoryRoomsQuery";
import {
  CATEGORY_BROWSE_PATH,
  CATEGORY_PARAM,
  CATEGORY_PUSH_STATE,
  categoryBrowsePath,
  categoryChipKey,
  categoryNavigationIntent,
  isCategoryPushEntry,
  parseCategorySelection,
  resolveSelectedCategory,
} from "@/features/category/categorySelection";
import { homeRecommendationsQueryOptions, trimRotatingRecommendPages } from "./homeQuery";
import { mergeRoomPages } from "./pagination";

type RoomGridProps = {
  rooms: readonly LiveRoomItem[];
};

const RoomGrid = memo(function RoomGrid({ rooms }: RoomGridProps) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {rooms.map((room) => (
        <div key={`${room.site_id}:${room.room_id}`}>
          <RoomCard room={room} />
        </div>
      ))}
    </div>
  );
});

/**
 * 推荐态下喂给分区 query 的中性分类。
 *
 * React hooks 规则要求两个 `useInfiniteQuery` 都无条件调用，因此推荐态也必须给
 * 分区 query 一个 key。空 id 刻意不可能匹配任何真实分区缓存，且该 query 此时
 * `enabled: false`，永远不会发出请求 —— 它只是占住 hook 位置，不产生占位数据。
 * 定义在模块作用域保持引用稳定，避免每次渲染都换一个 queryKey 数组。
 */
const IDLE_CATEGORY: LiveSubCategory = { id: "", name: "", parent_id: "", pic: null };

/** 分类树未就绪时的稳定空值，避免每次渲染换一个数组引用。 */
const EMPTY_CATEGORIES: readonly LiveCategory[] = [];

export function HomePage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // 「全部分类」按客户端分派到两种呈现：触摸端就地开底部抽屉（拇指可达、接系统
  // 返回键），桌面端跳独立的 `/category` 页（几百个分区铺在首页内容栏里会把房间
  // 网格挤到折叠之下，而桌面有完整的返回栈可用）。判定按客户端而不是视口宽度：
  // 桌面把窗口拖窄并不会让抽屉变成更好的选择。
  const mobile = isMobileClient();

  // 抽屉的展开态记的是「为哪个平台展开」，而不是布尔值。移动端横滑切平台不会重挂
  // 首页（Shell 的 outlet 以 pathname 为 key），若存布尔值就得再加一个副作用去
  // 收起抽屉；记住平台后，比较一次即可，无需副作用也不会多一轮渲染。
  const [panelOpenForSite, setPanelOpenForSite] = useState<string | null>(null);
  const panelOpen = panelOpenForSite === siteId;
  const setPanelOpen = (open: boolean) => setPanelOpenForSite(open ? siteId : null);

  const selection = useMemo(
    () => parseCategorySelection(searchParams.get(CATEGORY_PARAM), siteId),
    [searchParams, siteId],
  );

  const categoriesQuery = useQuery({
    queryKey: ["categories", siteId],
    queryFn: () => invokeCmd<LiveCategory[]>("site_get_categories", { siteId }),
    ...BROWSING_LIST_QUERY_OPTIONS,
  });
  // 引用要稳：`data ?? []` 每次渲染都产出新数组，会让下游按 `categories` 记忆化的
  // 计算全部失效。加载中与失败态共用同一个空数组常量。
  const categories = categoriesQuery.data ?? EMPTY_CATEGORIES;

  const selectedCategory = useMemo(
    () => (selection ? resolveSelectedCategory(categoriesQuery.data, selection) : null),
    [categoriesQuery.data, selection],
  );

  const recommendQuery = useInfiniteQuery({
    ...homeRecommendationsQueryOptions(siteId),
    enabled: !selection,
    // 在从未访问过的平台拉取首页时保持当前网格可见。避免页签切换期间用空白表面
    // 替换可用内容；查询缓存仍按 ["recommend", siteId] 分别存储各平台。
    placeholderData: keepPreviousData,
  });

  const categoryRoomsQuery = useInfiniteQuery({
    ...categoryRoomsQueryOptions(siteId, selectedCategory ?? IDLE_CATEGORY),
    enabled: Boolean(selection),
  });

  const query = selection ? categoryRoomsQuery : recommendQuery;
  const pages = query.data?.pages;
  const rooms = useMemo(() => mergeRoomPages(pages), [pages]);
  const hasNextPage = query.isPlaceholderData ? false : query.hasNextPage;

  const { fetchNextPage, isFetchingNextPage, isFetchNextPageError } = query;
  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  });

  const refreshing = query.isRefetching && !query.isFetchingNextPage;

  const refresh = () => {
    // 分类树失败后条带只剩「推荐」；一次下拉理应把它一起救回来，
    // 而不是逼用户再去点条带上的重试。成功缓存的分类树不会因此重复抓取。
    if (categoriesQuery.isError) void categoriesQuery.refetch();

    if (selection) {
      void categoryRoomsQuery.refetch();
      return;
    }
    // 轮换型信息流（如抖音）只需要一批新数据；先裁剪可以把对所有已存页面的串行
    // 重新抓取变成单次请求。
    trimRotatingRecommendPages(queryClient, siteId);
    void recommendQuery.refetch();
  };

  /**
   * 切换选中态。
   *
   * 滚动复位刻意不在这里做：这三种意图都会换掉一条历史记录（push 与 replace 都
   * 让 `location.key` 变化），Shell 的 `surfaceKey` 因此改变，它那段布局副作用
   * 对非 POP 导航一律 `scrollTo(0)`、只在 POP 时回放记忆位置。手动再复位一次会
   * 抢在记忆回放之前跑，把「历史返回仍按记忆回放」这条行为破坏掉。
   */
  const selectCategory = (category: LiveSubCategory | null) => {
    const next = category
      ? { siteId, parentId: category.parent_id, categoryId: category.id }
      : null;
    const intent = categoryNavigationIntent(selection, next, location.state);

    if (intent.kind === "back") {
      navigate(-1);
      return;
    }

    // 分区间 replace 必须把 push 标记带过去：被替换掉的正是当初 push 出来的那条
    // 记录，推荐态仍压在它下面。丢掉标记会让之后「回到推荐」退化成再 push 一条
    // 记录，系统返回键于是要按两次才能离开首页。
    const marked = intent.kind === "push" || isCategoryPushEntry(location.state);
    navigate(intent.path, {
      replace: intent.kind === "replace",
      state: marked ? CATEGORY_PUSH_STATE : undefined,
    });
  };

  const title = selection ? (selectedCategory?.name ?? "分区直播") : "推荐直播";

  return (
    <PullToRefresh onRefresh={refresh} refreshing={refreshing} className="mx-auto max-w-[1600px]">
      <RefreshFab
        onRefresh={refresh}
        pending={refreshing || query.isLoading}
        label={`刷新${title}`}
      />
      <div className="flex flex-col gap-4">
        <h1 className="sr-only">{title}</h1>

        <CategoryBar
          categories={categories}
          selection={selection}
          loading={categoriesQuery.isLoading}
          error={categoriesQuery.isError}
          onRetry={() => void categoriesQuery.refetch()}
          onSelect={selectCategory}
          panelExpanded={mobile ? panelOpen : undefined}
          onPanelEntry={() => {
            if (mobile) {
              setPanelOpen(!panelOpen);
              return;
            }
            // 把 push 标记带进 `/category`：那一页选中分区后会 replace 掉自己那条
            // 记录，于是新的分区态记录下面压着的仍是此刻这条首页记录。只有当前是
            // 推荐态时这个标记才成立 —— 从分区态进去，下面压着的是上一个分区。
            navigate(categoryBrowsePath(selection), {
              state: selection ? undefined : CATEGORY_PUSH_STATE,
            });
          }}
          onPanelEntryIntent={mobile ? undefined : () => preloadRouteModule(CATEGORY_BROWSE_PATH)}
        />

        {mobile && (
          <CategoryPanel
            open={panelOpen}
            onOpenChange={setPanelOpen}
            categories={categories}
            treeKey={siteId}
            selectedKey={
              selection ? categoryChipKey(selection.parentId, selection.categoryId) : null
            }
            onSelect={selectCategory}
          />
        )}

        {query.isLoading && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="aspect-video w-full rounded-xl" />
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        )}

        {query.isError && rooms.length === 0 && (
          <ErrorState
            error={query.error}
            title={selection ? `加载「${title}」失败` : "推荐直播加载失败"}
            onRetry={() => void query.refetch()}
          />
        )}

        {!query.isLoading &&
          !query.isError &&
          rooms.length === 0 &&
          (selection ? (
            <Empty className="min-h-64 py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Radio aria-hidden />
                </EmptyMedia>
                <EmptyTitle>这个分区暂时没有直播</EmptyTitle>
                <EmptyDescription>换个分区看看，或稍后再来刷新。</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={() => selectCategory(null)}>
                  <Sparkles data-icon="inline-start" aria-hidden />
                  回到推荐
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-24 text-muted-foreground">
              <p className="text-sm">暂无 {SITE_LABELS[siteId] ?? siteId} 推荐直播</p>
            </div>
          ))}

        {rooms.length > 0 && <RoomGrid rooms={rooms} />}

        {hasNextPage && (
          <div ref={loadMoreRef} className="flex min-h-11 items-center justify-center pt-3 pb-2">
            {query.isFetchingNextPage && (
              <span
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="animate-spin-soft" data-icon="inline-start" />
                加载中…
              </span>
            )}
            {query.isFetchNextPageError && (
              <Button variant="secondary" onClick={() => loadMore(true)}>
                重试加载
              </Button>
            )}
            {!supportsIntersectionObserver &&
              !query.isFetchingNextPage &&
              !query.isFetchNextPageError && (
                <Button variant="secondary" onClick={() => loadMore()}>
                  加载更多
                </Button>
              )}
          </div>
        )}
      </div>
    </PullToRefresh>
  );
}
