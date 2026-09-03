import { memo, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Loader2, Video } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  PgcItem,
  PgcListPage,
  VideoItem,
  VideoListPage,
  VideoZone,
} from "@/shared/types/video";
import {
  videoGetPgcIndex,
  videoGetPopular,
  videoGetRecommend,
  videoGetZone,
  videoZoneList,
} from "./videoApi";
import { PgcCard, VideoCard } from "./VideoCard";
import { SeasonEpisodeDialog } from "./SeasonEpisodeDialog";
import { VideoZoneBar } from "./VideoZoneBar";
import {
  PGC_SEASON_TYPES,
  VIDEO_POPULAR_ALL_ZONE_KEY,
  VIDEO_TAB_LABELS,
  VIDEO_TAB_PARAM,
  VIDEO_ZONE_PARAM,
  resolveVideoZoneKey,
  videoTabFromSearch,
  videoTabHasZoneStrip,
  videoTabUsesPgc,
  videoZoneChips,
} from "./videoRoute";

/** 分区列表未就绪时的稳定空值，避免每次渲染换一个数组引用。 */
const EMPTY_ZONES: readonly VideoZone[] = [];

/**
 * 一页列表。
 *
 * 三个列表接口返回两种条目形态（UGC 稿件 / PGC 剧集）。给 payload 打上 `kind`
 * 而不是在渲染处按页签断言：切页签那一帧缓存里可能还是上一个页签的数据，
 * 按页签强转会在那一帧把 PGC 条目当成 UGC 读。
 */
type VideoFeedPage = ({ kind: "ugc" } & VideoListPage) | ({ kind: "pgc" } & PgcListPage);

const GRID_CLASS =
  "grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

const VideoGrid = memo(function VideoGrid({ items }: { items: readonly VideoItem[] }) {
  return (
    <div className={GRID_CLASS}>
      {items.map((item) => (
        <VideoCard key={`${item.bvid}:${item.cid ?? ""}`} item={item} />
      ))}
    </div>
  );
});

const PgcGrid = memo(function PgcGrid({
  items,
  onSelect,
}: {
  items: readonly PgcItem[];
  onSelect: (item: PgcItem) => void;
}) {
  return (
    <div className={GRID_CLASS}>
      {items.map((item) => (
        <PgcCard key={item.season_id} item={item} onSelect={onSelect} />
      ))}
    </div>
  );
});

function GridSkeleton() {
  return (
    <div className={GRID_CLASS} aria-hidden>
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/**
 * `/video` 发现页。
 *
 * 四个内容页签住在 Shell 的头部槽位（见 `VideoTabSwitcher`），这一页只负责页签之下
 * 的两层：分区条与内容网格。页签与分区都走查询参数而不是路径段，于是换页签沿用
 * Shell 已有的页面平移，不必为四个表面各开一条路由。
 *
 * 番剧 / 影视点卡片不直接播，先经 `video_get_season` 展开分集，理由见
 * `SeasonEpisodeDialog`。
 */
export function VideoPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = videoTabFromSearch(searchParams.get(VIDEO_TAB_PARAM));
  const [openSeason, setOpenSeason] = useState<PgcItem | null>(null);

  // UGC 分区表由后端提供以免前端硬编码 rid。只有热门页签的条带用得上它。
  const zonesQuery = useQuery({
    queryKey: ["video_zone_list"],
    queryFn: videoZoneList,
    enabled: tab === "popular",
    ...BROWSING_LIST_QUERY_OPTIONS,
  });
  const ugcZones = zonesQuery.data ?? EMPTY_ZONES;
  const chips = useMemo(() => videoZoneChips(tab, ugcZones), [tab, ugcZones]);
  const zoneKey = resolveVideoZoneKey(tab, searchParams.get(VIDEO_ZONE_PARAM), chips);

  const listQuery = useInfiniteQuery({
    queryKey: ["video_list", tab, zoneKey ?? ""],
    initialPageParam: 1,
    queryFn: async ({ pageParam }): Promise<VideoFeedPage> => {
      const page = pageParam as number;
      if (tab === "recommend") return { kind: "ugc", ...(await videoGetRecommend(page)) };
      if (tab === "popular") {
        // 「全部」走可翻页的全站热门榜；具体分区走分区榜，后端的 has_more 恒为 false。
        if (!zoneKey || zoneKey === VIDEO_POPULAR_ALL_ZONE_KEY) {
          return { kind: "ugc", ...(await videoGetPopular(page)) };
        }
        return { kind: "ugc", ...(await videoGetZone(Number(zoneKey))) };
      }
      // 番剧 / 影视：分区条选的是 season_type。影视额外带 index_type=102，
      // 见设计文档第三节 —— 两者共用 `pgc_index`，只差这个筛选位。
      const seasonType = Number(zoneKey ?? PGC_SEASON_TYPES.anime);
      const indexType = tab === "cinema" ? 102 : null;
      return { kind: "pgc", ...(await videoGetPgcIndex(seasonType, indexType, page)) };
    },
    // 分页语义完全信后端的 `has_more`：分区/排行榜类接口是榜单，它恒为 false，
    // 前端不去猜「返回条数少于 pageSize 就是最后一页」。
    getNextPageParam: (lastPage, allPages) =>
      lastPage.has_more ? allPages.length + 1 : undefined,
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const pages = listQuery.data?.pages;
  // 按 payload 自带的 `kind` 分派，理由见 `VideoFeedPage`。
  const feedKind = pages?.[0]?.kind ?? (videoTabUsesPgc(tab) ? "pgc" : "ugc");
  const ugcItems = useMemo(
    () => pages?.flatMap((page) => (page.kind === "ugc" ? page.items : [])) ?? [],
    [pages],
  );
  const pgcItems = useMemo(
    () => pages?.flatMap((page) => (page.kind === "pgc" ? page.items : [])) ?? [],
    [pages],
  );
  const itemCount = feedKind === "pgc" ? pgcItems.length : ugcItems.length;

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = listQuery;
  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  });

  const refreshing = listQuery.isRefetching && !listQuery.isFetchingNextPage;
  const title = `${VIDEO_TAB_LABELS[tab]}视频`;

  const refresh = () => {
    // 分区表失败后条带是空的；一次下拉理应把它一起救回来。
    if (zonesQuery.isError) void zonesQuery.refetch();
    void listQuery.refetch();
  };

  const selectZone = (key: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(VIDEO_ZONE_PARAM, key);
    // replace：换分区不该在返回栈里堆一层，与首页换分区的取向一致。
    setSearchParams(next, { replace: true });
  };

  return (
    <PullToRefresh onRefresh={refresh} refreshing={refreshing} className="mx-auto max-w-[1600px]">
      <RefreshFab
        onRefresh={refresh}
        pending={refreshing || listQuery.isLoading}
        label={`刷新${title}`}
      />
      <div className="flex flex-col gap-4">
        <h1 className="sr-only">{title}</h1>

        {/* 推荐没有分区条：它就是一条个性化信息流，没有分区概念。其余三个页签都有：
            热门挂 UGC 分区（首项「全部」= 全站热门榜），番剧/影视挂 season_type 筛选。 */}
        {videoTabHasZoneStrip(tab) && (
          <VideoZoneBar
            chips={chips}
            selectedKey={zoneKey}
            loading={zonesQuery.isLoading}
            onSelect={selectZone}
          />
        )}

        {listQuery.isLoading && <GridSkeleton />}

        {listQuery.isError && itemCount === 0 && (
          <ErrorState
            error={listQuery.error}
            title={`${title}加载失败`}
            onRetry={() => void listQuery.refetch()}
          />
        )}

        {!listQuery.isLoading && !listQuery.isError && itemCount === 0 && (
          <Empty className="min-h-64 py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Video aria-hidden />
              </EmptyMedia>
              <EmptyTitle>这里暂时没有内容</EmptyTitle>
              <EmptyDescription>换个页签或分区看看，或稍后再来刷新。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {itemCount > 0 &&
          (feedKind === "pgc" ? (
            <PgcGrid items={pgcItems} onSelect={setOpenSeason} />
          ) : (
            <VideoGrid items={ugcItems} />
          ))}

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
            {isFetchNextPageError && (
              <Button variant="secondary" onClick={() => loadMore(true)}>
                重试加载
              </Button>
            )}
            {!supportsIntersectionObserver && !isFetchingNextPage && !isFetchNextPageError && (
              <Button variant="secondary" onClick={() => loadMore()}>
                加载更多
              </Button>
            )}
          </div>
        )}
      </div>

      <SeasonEpisodeDialog
        item={openSeason}
        onOpenChange={(open) => {
          if (!open) setOpenSeason(null);
        }}
      />
    </PullToRefresh>
  );
}
