import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { douyinVideoFeed, type DouyinVideoItem } from "./douyinVideoApi";
import { mergeDouyinFeed, nextDouyinFeedBatch } from "./douyinFeed";
import { shortsShouldFetchMore } from "./shortsFeed";

/** 与 B 站共用临近末尾补货策略；推荐缓存只存元数据，不持有媒体/账号。 */
export function useDouyinShortsFeed(motionActive: boolean) {
  const ownerId = useId();
  const [index, setIndex] = useState(0);
  const [items, setItems] = useState<DouyinVideoItem[]>([]);
  const query = useInfiniteQuery({
    queryKey: ["douyin_video_feed", "douyin", ownerId],
    initialPageParam: 1,
    queryFn: async ({ signal }) => {
      const page = await douyinVideoFeed();
      // Tauri invoke 不可撤回，刷新/离页后迟到的元数据不可重新发布。
      signal.throwIfAborted();
      return page;
    },
    getNextPageParam: nextDouyinFeedBatch,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const loaded = useMemo(() => mergeDouyinFeed(query.data?.pages ?? []), [query.data]);

  // 跟手/收尾期间只接收查询结果，不移动舞台坐标；已缓存的条数仍算补货余量。
  if (!motionActive && items !== loaded) setItems(loaded);

  useEffect(() => {
    if (
      !query.isFetchNextPageError &&
      shortsShouldFetchMore(index, loaded.length, query.hasNextPage, query.isFetching)
    ) {
      void query.fetchNextPage({ cancelRefetch: false });
    }
  }, [index, loaded.length, query]);

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetching) {
      void query.fetchNextPage({ cancelRefetch: false });
    }
  }, [query]);

  return { items, index, setIndex, query, loadMore };
}
