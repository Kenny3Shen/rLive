import {
  hashKey,
  type InfiniteData,
  type InfiniteQueryObserverOptions,
  type QueryClient,
  type QueryFunctionContext,
  type QueryKey,
} from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { categoryRoomsQueryOptions } from "@/features/category/categoryRoomsQuery";
import type { LiveSubCategory, RoomListPage, SiteId } from "@/shared/types/live";
import { nextRecommendPage } from "./pagination";
import { roomCoverSnapshot } from "@/shared/api/roomCoverSnapshot";

export type HomeRoomPageFetcher = (page: number) => Promise<RoomListPage>;

/**
 * 首页推荐的查询键。
 *
 * 第三个槽位是「本机 TV 授权版本」，只对 B 站有意义：它的直播首页推荐会带上
 * TV 凭据（见 `src-tauri/src/commands/site.rs` 的 `resolve_recommend_site`），
 * 换账号或移除授权后旧缓存必须失效，否则用户会看到「切了没变」。
 * 其他平台恒为 0，键的形状保持稳定。
 */
export type RecommendQueryKey = readonly ["recommend", SiteId, number];

function recommendQueryKey(siteId: SiteId, appAuthRevision: number): RecommendQueryKey {
  return ["recommend", siteId, siteId === "bilibili" ? appAuthRevision : 0];
}

export function homeRecommendationsQueryOptions(
  siteId: SiteId,
  appAuthRevision = 0,
  fetchPage: HomeRoomPageFetcher = (page) =>
    invokeCmd<RoomListPage>("site_get_recommend", { siteId, page }),
) {
  return {
    queryKey: recommendQueryKey(siteId, appAuthRevision),
    queryFn: async ({ pageParam, signal }: QueryFunctionContext<RecommendQueryKey, number>) => {
      const page = await fetchPage(pageParam);
      // Tauri IPC 本身不能取消；取消后必须丢弃迟到页，不能让旧补货覆盖新首页。
      signal.throwIfAborted();
      return roomCoverSnapshot(page);
    },
    initialPageParam: 1,
    getNextPageParam: nextRecommendPage,
    ...BROWSING_LIST_QUERY_OPTIONS,
  };
}

/** 在页签点击需要之前启动平台信息流。QueryClient 会合并在途调用。 */
export function prefetchHomeRecommendations(
  queryClient: QueryClient,
  siteId: SiteId,
  appAuthRevision = 0,
): void {
  void queryClient.prefetchInfiniteQuery(homeRecommendationsQueryOptions(siteId, appAuthRevision));
}

/**
 * 刷新期间只请求首页。无限查询直接 `refetch()` 会按顺序重取所有已加载页，用户
 * 浏览越深等待越长；这里在请求前取消在途补货，并让 `pages: 1` 覆盖旧多页结果。
 * 请求失败时 TanStack 保留已有数据，只记录可重试错误。
 */
type HomeRoomListInfiniteOptions<TQueryKey extends QueryKey> = InfiniteQueryObserverOptions<
  RoomListPage,
  Error,
  InfiniteData<RoomListPage, number>,
  TQueryKey,
  number
>;

const firstPageRefreshes = new WeakMap<
  QueryClient,
  Map<string, Promise<InfiniteData<RoomListPage, number>>>
>();

/** 刷新结束时只有发起它的 query 仍被当前页面观察，才允许联动页面滚动。 */
export function homeQueryIsActive(queryClient: QueryClient, queryKey: QueryKey): boolean {
  return queryClient.getQueryCache().find({ queryKey, exact: true })?.isActive() ?? false;
}

/**
 * 成功刷新后等回顶帧完成，再让外层结束忙碌态。
 *
 * 查询虽然已经提交新首页，但浏览器的滚动位置要到下一帧才会复位。若这里提前
 * 返回，无限加载哨兵会在旧页尾短暂恢复，可能在回顶前继续补第二页。
 */
export function waitForHomeRefreshScroll(
  queryClient: QueryClient,
  queryKey: QueryKey,
  scheduleFrame: (callback: () => void) => void,
  scrollToTop: () => void,
): Promise<void> {
  if (!homeQueryIsActive(queryClient, queryKey)) return Promise.resolve();

  return new Promise((resolve) => {
    scheduleFrame(() => {
      if (homeQueryIsActive(queryClient, queryKey)) scrollToTop();
      resolve();
    });
  });
}

function refreshRoomListFirstPage<TQueryKey extends QueryKey>(
  queryClient: QueryClient,
  options: HomeRoomListInfiniteOptions<TQueryKey>,
): Promise<InfiniteData<RoomListPage, number>> {
  const queryKey = options.queryKey;
  const hash = hashKey(queryKey);
  let clientRefreshes = firstPageRefreshes.get(queryClient);
  if (!clientRefreshes) {
    clientRefreshes = new Map();
    firstPageRefreshes.set(queryClient, clientRefreshes);
  }
  const existing = clientRefreshes.get(hash);
  if (existing) return existing;

  const refresh = (async () => {
    // 旧补货即使迟到，也不能覆盖本轮新首页。
    await queryClient.cancelQueries({ queryKey });
    return queryClient.infiniteQuery<
      RoomListPage,
      Error,
      InfiniteData<RoomListPage, number>,
      TQueryKey,
      number
    >({
      ...options,
      // 显式刷新忽略永久新鲜的浏览缓存，并只重建首页。
      pages: 1,
      staleTime: 0,
    });
  })().finally(() => {
    if (clientRefreshes?.get(hash) === refresh) clientRefreshes.delete(hash);
  });

  clientRefreshes.set(hash, refresh);
  return refresh;
}

export function refreshHomeRecommendationsFirstPage(
  queryClient: QueryClient,
  siteId: SiteId,
  appAuthRevision = 0,
  fetchPage?: HomeRoomPageFetcher,
): Promise<InfiniteData<RoomListPage, number>> {
  return refreshRoomListFirstPage(
    queryClient,
    homeRecommendationsQueryOptions(siteId, appAuthRevision, fetchPage),
  );
}

/** 首页里的分区列表在取消旧补货后，同样不能提交迟到的旧页。 */
export function homeCategoryRoomsQueryOptions(
  siteId: SiteId,
  category: LiveSubCategory,
  fetchPage?: HomeRoomPageFetcher,
) {
  const options = categoryRoomsQueryOptions(siteId, category);
  return {
    ...options,
    queryFn: async (context: Parameters<typeof options.queryFn>[0]) => {
      if (fetchPage) {
        const page = await fetchPage(context.pageParam);
        context.signal.throwIfAborted();
        return roomCoverSnapshot(page);
      }
      const page = await options.queryFn(context);
      context.signal.throwIfAborted();
      return page;
    },
  };
}

export function refreshCategoryRoomsFirstPage(
  queryClient: QueryClient,
  siteId: SiteId,
  category: LiveSubCategory,
  fetchPage?: HomeRoomPageFetcher,
): Promise<InfiniteData<RoomListPage, number>> {
  return refreshRoomListFirstPage(
    queryClient,
    homeCategoryRoomsQueryOptions(siteId, category, fetchPage),
  );
}
