import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { videoGetStory, videoGetUploaderStory } from "@/features/video/videoApi";
import type { VideoItem, VideoUploaderStoryPage } from "@/shared/types/video";
import {
  createShortsFeedMerger,
  shortsShouldFetchMore,
  SHORTS_PREFETCH_REMAINING,
} from "./shortsFeed";
import {
  shortsAnchoredIndex,
  shortsUploaderCounter,
  shortsUploaderCursor,
  shortsUploaderInitialIndex,
  shortsUploaderItems,
  shortsValidateUploaderPage,
  type ShortsUploaderDirection,
  type ShortsUploaderPageParam,
} from "./shortsUploaderFeed";

type FeedView = { source: number; items: VideoItem[]; index: number };
type UploaderTarget = { session: number; mid: string; aid: string; recommendation: FeedView };
type UploaderData = InfiniteData<VideoUploaderStoryPage, ShortsUploaderPageParam>;

/** 推荐与 UP 的查询/位置各自隔离，播放器与手势仍只消费一份当前视图。 */
export function useShortsFeed(entrySeed: string | null, motionActive: boolean) {
  const client = useQueryClient();
  const [target, setTarget] = useState<UploaderTarget | null>(null);
  const [view, setView] = useState<FeedView>({ source: 0, items: [], index: 0 });
  const sessionRef = useRef(0);
  const storySeedRef = useRef(entrySeed);
  const [failures, setFailures] = useState<
    Record<number, Partial<Record<ShortsUploaderDirection, unknown>>>
  >({});
  const fetchingRef = useRef<number | null>(null);

  const feedQuery = useInfiniteQuery({
    queryKey: ["shorts_story"],
    enabled: !target,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => videoGetStory(pageParam > 1, storySeedRef.current),
    getNextPageParam: (lastPage, allPages) => (lastPage.has_more ? allPages.length + 1 : undefined),
    staleTime: Infinity,
    gcTime: 0,
    // 在 UP 模式返回时保留原推荐序列，不因窗口重新聚焦或 enabled 翻转重排。
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const mergeRecommendation = useMemo(() => createShortsFeedMerger(), []);
  const recommendationItems = useMemo(
    () => mergeRecommendation(feedQuery.data?.pages ?? []),
    [feedQuery.data, mergeRecommendation],
  );
  const queryKey = ["shorts_uploader_story", target?.mid, target?.aid, target?.session] as const;
  const uploaderQuery = useInfiniteQuery({
    queryKey,
    enabled: !!target,
    initialPageParam: {
      direction: "initial",
      cursor: target?.aid ?? "",
    } as ShortsUploaderPageParam,
    queryFn: async ({ pageParam }) => {
      if (!target) throw new Error("尚未选择 UP 主。");
      const page = await videoGetUploaderStory(target.mid, pageParam.cursor, pageParam.direction);
      const previous = client.getQueryData<UploaderData>(queryKey);
      return shortsValidateUploaderPage(page, pageParam, previous?.pages, previous?.pageParams);
    },
    getNextPageParam: (page): ShortsUploaderPageParam | undefined => {
      const cursor = shortsUploaderCursor(page, "next");
      return cursor ? { direction: "next", cursor } : undefined;
    },
    getPreviousPageParam: (page): ShortsUploaderPageParam | undefined => {
      const cursor = shortsUploaderCursor(page, "prev");
      return cursor ? { direction: "prev", cursor } : undefined;
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const uploaderItems = useMemo(
    () => shortsUploaderItems(uploaderQuery.data?.pages ?? []),
    [uploaderQuery.data],
  );

  const uploaderIndex = useMemo(
    () => new Map(uploaderItems.map((item) => [item.aid, item])),
    [uploaderItems],
  );

  // 手势按下与收尾期间保持整份视图不变。响应可进查询缓存，但不能移动舞台坐标。
  // 渲染期一起提交 items/index：effect 补下标会先让错误视频起播一帧。
  if (!motionActive) {
    if (
      target &&
      uploaderQuery.data &&
      (view.source !== target.session || view.items !== uploaderItems)
    ) {
      const index =
        view.source === target.session
          ? shortsAnchoredIndex(uploaderItems, view.items[view.index], view.index)
          : shortsUploaderInitialIndex(uploaderItems, target.aid);
      setView({ source: target.session, items: uploaderItems, index });
    } else if (!target && view.items !== recommendationItems) {
      setView({
        source: 0,
        items: recommendationItems,
        index: shortsAnchoredIndex(recommendationItems, view.items[view.index], view.index),
      });
    }
  }

  const current = view.items[view.index];
  useEffect(() => {
    if (!target && current?.bvid) storySeedRef.current = current.bvid;
  }, [current?.bvid, target]);

  const enterUploader = useCallback(() => {
    const item = view.items[view.index];
    const mid = item?.author_mid?.trim();
    if (!item || !mid || motionActive || target?.mid === mid) return;
    // 同一次入口的重复点击不产生第二个 session；不同入口/退出重进永远不用旧响应。
    sessionRef.current += 1;
    setTarget({
      session: sessionRef.current,
      mid,
      aid: item.aid,
      recommendation: target?.recommendation ?? view,
    });
  }, [motionActive, target, view]);
  const exitUploader = useCallback(() => {
    if (!target) return;
    setView(target.recommendation);
    setTarget(null);
  }, [target]);
  const setIndex = useCallback((index: number) => {
    setView((previous) => ({ ...previous, index }));
  }, []);

  const directionFailures = target ? failures[target.session] : undefined;
  const load = useCallback(
    async (direction: ShortsUploaderDirection, retry = false) => {
      if (!target || fetchingRef.current === target.session || uploaderQuery.isFetching) return;
      if (!retry && failures[target.session]?.[direction]) return;
      if (direction === "next" ? !uploaderQuery.hasNextPage : !uploaderQuery.hasPreviousPage)
        return;
      fetchingRef.current = target.session;
      try {
        const fetch =
          direction === "next" ? uploaderQuery.fetchNextPage : uploaderQuery.fetchPreviousPage;
        await fetch({ cancelRefetch: false, throwOnError: true });
        setFailures((previous) => ({
          ...previous,
          [target.session]: { ...previous[target.session], [direction]: undefined },
        }));
      } catch (error) {
        // 按 session 记错；切 UP/退出后到达的拒绝不能污染新的入口。
        setFailures((previous) => ({
          ...previous,
          [target.session]: { ...previous[target.session], [direction]: error },
        }));
      } finally {
        if (fetchingRef.current === target.session) fetchingRef.current = null;
      }
    },
    [failures, target, uploaderQuery],
  );

  useEffect(() => {
    if (!target) {
      if (
        !feedQuery.isFetchNextPageError &&
        shortsShouldFetchMore(
          view.index,
          recommendationItems.length,
          feedQuery.hasNextPage,
          feedQuery.isFetching,
        )
      ) {
        void feedQuery.fetchNextPage({ cancelRefetch: false });
      }
      return;
    }
    if (view.source !== target.session || uploaderQuery.isFetching) return;
    // 已进缓存但尚未提交的前插/追加也算补货余量，避免长按时因旧坐标持续拉页。
    const loadedIndex = shortsAnchoredIndex(uploaderItems, current, view.index);
    if (
      loadedIndex <= SHORTS_PREFETCH_REMAINING &&
      uploaderQuery.hasPreviousPage &&
      !directionFailures?.prev
    ) {
      // 这里同步的是异步分页请求；状态更新只发生在 await 后的成功/失败分支。
      // oxlint-disable-next-line react/set-state-in-effect
      void load("prev");
    } else if (
      shortsShouldFetchMore(loadedIndex, uploaderItems.length, uploaderQuery.hasNextPage, false) &&
      !directionFailures?.next
    ) {
      void load("next");
    }
  }, [
    current,
    directionFailures,
    feedQuery,
    load,
    recommendationItems.length,
    target,
    uploaderItems,
    uploaderQuery,
    view,
  ]);

  const uploaderReady = !!target && view.source === target.session;
  const total = uploaderQuery.data?.pages[0]?.total ?? 0;
  const counter = uploaderReady
    ? shortsUploaderCounter(current ? uploaderIndex.get(current.aid) : undefined, total)
    : null;
  return {
    items: view.items,
    index: view.index,
    setIndex,
    feedQuery,
    uploaderQuery,
    uploaderMode: !!target,
    uploaderReady,
    navigationLocked: !!target && !uploaderReady,
    counter,
    enterUploader,
    exitUploader,
    directionFailures,
    load,
    hasPreviousPage: uploaderReady && uploaderQuery.hasPreviousPage,
    hasNextPage: target ? uploaderReady && uploaderQuery.hasNextPage : feedQuery.hasNextPage,
  };
}
