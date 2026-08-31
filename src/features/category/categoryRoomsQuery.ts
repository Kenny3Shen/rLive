import type { QueryFunctionContext } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import type { LiveSubCategory, RoomListPage, SiteId } from "@/shared/types/live";

type CategoryRoomsQueryKey = readonly ["category_rooms", SiteId, string, string];

/**
 * 分区房间无限流。key 沿用 `["category_rooms", siteId, parentId, categoryId]`
 * 以复用现有缓存，并且只由 id 组成 —— 分类展示名变化不该让缓存作废。
 *
 * 刻意不设 `placeholderData: keepPreviousData`。换区是直接替换内容，占位数据会让
 * chip 高亮已经跳到新分区、网格却还显示上一个分区的房间 —— 用户可能点进一个
 * 并不属于所选分区的房间。已访问过的分区靠 `BROWSING_LIST_QUERY_OPTIONS` 的
 * `staleTime: Infinity` 同步命中缓存，本来就不闪 skeleton；未访问过的分区
 * 显示 skeleton 是诚实的。
 */
export function categoryRoomsQueryOptions(siteId: SiteId, category: LiveSubCategory) {
  return {
    queryKey: ["category_rooms", siteId, category.parent_id, category.id] as CategoryRoomsQueryKey,
    queryFn: ({ pageParam }: QueryFunctionContext<CategoryRoomsQueryKey, number>) =>
      invokeCmd<RoomListPage>("site_get_category_rooms", {
        siteId,
        category,
        page: pageParam,
      }),
    initialPageParam: 1,
    getNextPageParam: (last: RoomListPage, _pages: unknown, lastPageParam: number) =>
      last.has_more ? lastPageParam + 1 : undefined,
    ...BROWSING_LIST_QUERY_OPTIONS,
  };
}
