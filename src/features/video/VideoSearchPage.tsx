import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { videoSearch } from "./videoApi";
import { VideoGrid } from "./VideoCard";
import { VideoSearchFiltersBar } from "./VideoSearchFiltersBar";
import { dedupeVideoItems, playlistItemFromVideoItem } from "./playlistStore";
import {
  VIDEO_SEARCH_QUERY_PARAM,
  parseVideoSearchFilters,
  videoSearchPath,
  type VideoSearchFilters,
} from "./videoRoute";

/**
 * `/video/search` 搜索结果页。
 *
 * 查询条住在 Shell 头部（`VideoSearchBar`），关键词由 URL `?q=` 携带；
 * 这一页只负责结果网格与无限滚动，滚动交给 Shell 的页面滚动容器。
 */
export function VideoSearchPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const keyword = (searchParams.get(VIDEO_SEARCH_QUERY_PARAM) ?? "").trim();
  const filters = parseVideoSearchFilters(searchParams);

  const listQuery = useInfiniteQuery({
    queryKey: ["video", "search", keyword, filters],
    queryFn: ({ pageParam }) => videoSearch(keyword, pageParam, filters),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.has_more ? lastPageParam + 1 : undefined,
    enabled: keyword.length > 0,
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    refetch,
  } = listQuery;

  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  });

  const allItems = dedupeVideoItems(data?.pages.flatMap((page) => page.items) ?? []);
  // 点击时刻的列表快照即播放列表（搜索结果连播）。allItems 每次渲染都是新数组，
  // 顺带计算不额外记忆化，量级最多几十条。
  const playlistItems = allItems.map(playlistItemFromVideoItem);
  const isEmpty = !isFetching && keyword && allItems.length === 0;
  const changeFilters = (next: VideoSearchFilters) => {
    // 与首页换分区同一取向：改筛选不往返回栈里堆一层。默认位不进 URL，与
    // `videoSearchPath` 的编码一致。
    navigate(videoSearchPath(keyword, next), { replace: true });
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 pb-6">
      {keyword && <VideoSearchFiltersBar filters={filters} onChange={changeFilters} />}

      {error ? (
        <ErrorState error={error} title="搜索失败" onRetry={() => refetch()} />
      ) : isEmpty ? (
        <Empty className="min-h-56 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search aria-hidden />
            </EmptyMedia>
            <EmptyTitle>未找到相关视频</EmptyTitle>
            <EmptyDescription>试试其他关键词</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : allItems.length > 0 ? (
        <>
          <VideoGrid items={allItems} playlist={playlistItems} />
          {hasNextPage && (
            <div ref={loadMoreRef} className="flex min-h-11 items-center justify-center pt-3 pb-2">
              {isFetchingNextPage && (
                <span
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 className="animate-spin-soft" data-icon="inline-start" />
                  加载中…
                </span>
              )}
            </div>
          )}
          {!supportsIntersectionObserver && hasNextPage && (
            <div className="flex justify-center py-4">
              <Button onClick={() => loadMore()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? "加载中..." : "加载更多"}
              </Button>
            </div>
          )}
        </>
      ) : keyword ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-8 animate-spin" />
        </div>
      ) : (
        <Empty className="min-h-56 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search aria-hidden />
            </EmptyMedia>
            <EmptyTitle>搜索 B 站视频</EmptyTitle>
            <EmptyDescription>在上方输入关键词开始搜索</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
