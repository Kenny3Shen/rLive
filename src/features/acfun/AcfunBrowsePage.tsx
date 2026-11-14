import { useMemo, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { BookOpenText, Loader2, Video } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { VideoZoneBar } from "@/features/video/VideoZoneBar";
import { VIDEO_POPULAR_ALL_ZONE_KEY } from "@/features/video/videoRoute";
import { ACFUN_CHANNEL_PARAM, ACFUN_SECTION_PARAM, type AcfunView } from "./acfunRoute";
import {
  acfunArticleGetChannels,
  acfunArticleGetFeed,
  acfunVideoGetRecommend,
  acfunVideoGetSection,
  acfunVideoGetSections,
} from "./acfunApi";
import { AcfunCardGrid, AcfunGridSkeleton } from "./AcfunCards";
import { dedupeAcfunItems } from "./acfunFeed";
import type {
  AcfunArticleItem,
  AcfunArticleListPage,
  AcfunVideoItem,
  AcfunVideoListPage,
} from "./acfunTypes";

type AcfunFeedPage =
  | { kind: "video"; value: AcfunVideoListPage }
  | { kind: "article"; value: AcfunArticleListPage };

function LoadMoreButton({
  pending,
  visible,
  error,
  onLoad,
}: {
  pending: boolean;
  visible: boolean;
  error: boolean;
  onLoad: (retry?: boolean) => void;
}) {
  if (!visible) return null;
  return (
    <div className="flex justify-center py-2">
      <Button variant="outline" disabled={pending} onClick={() => onLoad(error)}>
        {pending && <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden />}
        {error ? "重试加载" : "加载更多"}
      </Button>
    </div>
  );
}

export function AcfunBrowsePage({ view }: { view: AcfunView }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const sectionsQuery = useQuery({
    queryKey: ["acfun_video_sections"],
    queryFn: acfunVideoGetSections,
    enabled: view === "video",
    ...BROWSING_LIST_QUERY_OPTIONS,
  });
  const channelsQuery = useQuery({
    queryKey: ["acfun_article_channels"],
    queryFn: acfunArticleGetChannels,
    enabled: view === "article",
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const sectionIds = sectionsQuery.data?.map((section) => section.id) ?? [];
  const channelIds = channelsQuery.data?.map((channel) => channel.id) ?? [];
  const requestedSection = searchParams.get(ACFUN_SECTION_PARAM);
  const requestedChannel = searchParams.get(ACFUN_CHANNEL_PARAM);
  const selectedSection =
    requestedSection && sectionIds.includes(requestedSection) ? requestedSection : null;
  const selectedChannel =
    requestedChannel && channelIds.includes(requestedChannel) ? requestedChannel : null;

  const feedKey = ["acfun_feed", view, selectedSection ?? "", selectedChannel ?? ""] as const;
  const feedQuery = useInfiniteQuery({
    queryKey: feedKey,
    initialPageParam: view === "video" ? 1 : "",
    queryFn: async ({ pageParam }): Promise<AcfunFeedPage> => {
      if (view === "video") {
        const page = pageParam as number;
        const value = selectedSection
          ? await acfunVideoGetSection(selectedSection, page)
          : await acfunVideoGetRecommend(page);
        return { kind: "video", value };
      }
      const cursor = typeof pageParam === "string" ? pageParam : "";
      const value = await acfunArticleGetFeed(selectedChannel, cursor || null);
      return { kind: "article", value };
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage.value.has_more) return undefined;
      if (lastPage.kind === "video") return lastPage.value.next_page ?? undefined;
      return lastPage.value.next_cursor ?? undefined;
    },
    placeholderData: keepPreviousData,
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const items = useMemo<readonly (AcfunVideoItem | AcfunArticleItem)[]>(() => {
    if (!feedQuery.data) return [];
    return dedupeAcfunItems(
      feedQuery.data.pages.flatMap(
        (page): readonly (AcfunVideoItem | AcfunArticleItem)[] => page.value.items,
      ),
    );
  }, [feedQuery.data]);
  const displayItems =
    feedQuery.isPlaceholderData && feedQuery.data?.pages[0]?.kind !== view ? [] : items;

  const hasNextPage = feedQuery.isPlaceholderData ? false : feedQuery.hasNextPage;
  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage: feedQuery.isFetchingNextPage,
    isFetchNextPageError: feedQuery.isFetchNextPageError,
    fetchNextPage: feedQuery.fetchNextPage,
  });
  const refreshing = manualRefreshing || (feedQuery.isRefetching && !feedQuery.isFetchingNextPage);

  const refresh = () => {
    setManualRefreshing(true);
    const metadataRefresh =
      view === "video" && sectionsQuery.isError
        ? sectionsQuery.refetch()
        : view === "article" && channelsQuery.isError
          ? channelsQuery.refetch()
          : Promise.resolve();
    void Promise.all([metadataRefresh, queryClient.resetQueries({ queryKey: feedKey })]).finally(
      () => setManualRefreshing(false),
    );
  };

  const sectionChips = [
    { key: VIDEO_POPULAR_ALL_ZONE_KEY, label: "热门" },
    ...(sectionsQuery.data?.map((section) => ({ key: section.id, label: section.name })) ?? []),
  ];

  const selectVideoSection = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (key === VIDEO_POPULAR_ALL_ZONE_KEY) next.delete(ACFUN_SECTION_PARAM);
    else next.set(ACFUN_SECTION_PARAM, key);
    next.delete(ACFUN_CHANNEL_PARAM);
    setSearchParams(next, { replace: true });
  };

  const selectArticleChannel = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (key === VIDEO_POPULAR_ALL_ZONE_KEY) next.delete(ACFUN_CHANNEL_PARAM);
    else next.set(ACFUN_CHANNEL_PARAM, key);
    next.delete(ACFUN_SECTION_PARAM);
    setSearchParams(next, { replace: true });
  };

  const title = view === "video" ? "AcFun 视频" : "AcFun 文章";
  const emptyIcon = view === "video" ? <Video aria-hidden /> : <BookOpenText aria-hidden />;

  return (
    <PullToRefresh onRefresh={refresh} refreshing={refreshing} className="mx-auto max-w-[1600px]">
      <RefreshFab
        onRefresh={refresh}
        pending={refreshing || feedQuery.isLoading}
        label={`刷新${title}`}
      />
      <div className="flex flex-col gap-4">
        <h1 className="sr-only">{title}</h1>

        {view === "video" ? (
          <VideoZoneBar
            chips={sectionChips}
            selectedKey={selectedSection ?? VIDEO_POPULAR_ALL_ZONE_KEY}
            loading={sectionsQuery.isLoading}
            onSelect={selectVideoSection}
            ariaLabel="AcFun 视频分区"
          />
        ) : (
          <VideoZoneBar
            chips={[
              { key: VIDEO_POPULAR_ALL_ZONE_KEY, label: "综合" },
              ...(channelsQuery.data?.map((channel) => ({
                key: channel.id,
                label: channel.name,
              })) ?? []),
            ]}
            selectedKey={selectedChannel ?? VIDEO_POPULAR_ALL_ZONE_KEY}
            loading={channelsQuery.isLoading}
            onSelect={selectArticleChannel}
            ariaLabel="AcFun 文章频道"
          />
        )}

        {(feedQuery.isLoading || (feedQuery.isPlaceholderData && displayItems.length === 0)) && (
          <AcfunGridSkeleton />
        )}

        {feedQuery.isError && displayItems.length === 0 && (
          <ErrorState
            error={feedQuery.error}
            title={`${title}加载失败`}
            onRetry={() => void feedQuery.refetch()}
          />
        )}

        {!feedQuery.isLoading && !feedQuery.isError && displayItems.length === 0 && (
          <Empty className="min-h-64 py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">{emptyIcon}</EmptyMedia>
              <EmptyTitle>这里暂时没有内容</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}

        {displayItems.length > 0 && <AcfunCardGrid kind={view} items={displayItems} />}
        {feedQuery.isFetchingNextPage && (
          <div className="flex justify-center py-3" role="status">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="正在加载" />
          </div>
        )}
        {!supportsIntersectionObserver && (
          <LoadMoreButton
            pending={feedQuery.isFetchingNextPage}
            visible={Boolean(hasNextPage)}
            error={feedQuery.isFetchNextPageError}
            onLoad={loadMore}
          />
        )}
        <div ref={loadMoreRef} className="h-px" aria-hidden />
        {feedQuery.isFetchNextPageError && (
          <ErrorState
            error={feedQuery.error}
            title="下一页加载失败"
            onRetry={() => loadMore(true)}
          />
        )}
      </div>
    </PullToRefresh>
  );
}
