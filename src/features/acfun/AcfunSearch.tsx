import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { BookOpenText, Loader2, Search, Video } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ErrorState } from "@/shared/components/ErrorState";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { AcfunContentSwitcher } from "./AcfunContentSwitcher";
import { acfunArticleSearch, acfunVideoSearch } from "./acfunApi";
import { AcfunCardGrid, AcfunGridSkeleton } from "./AcfunCards";
import { dedupeAcfunItems } from "./acfunFeed";
import {
  acfunHomePath,
  ACFUN_SEARCH_QUERY_PARAM,
  ACFUN_VIEW_PARAM,
  acfunSearchPath,
  acfunViewFromSearch,
  type AcfunView,
} from "./acfunRoute";
import type {
  AcfunArticleItem,
  AcfunArticleListPage,
  AcfunVideoItem,
  AcfunVideoListPage,
} from "./acfunTypes";

type SearchPage = AcfunVideoListPage | AcfunArticleListPage;

export function AcfunSearchPage({ view: requestedView }: { view?: AcfunView } = {}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const view = requestedView ?? acfunViewFromSearch(params.get(ACFUN_VIEW_PARAM));
  const keyword = (params.get(ACFUN_SEARCH_QUERY_PARAM) ?? "").trim();
  const query = useInfiniteQuery({
    queryKey: ["acfun_search", view, keyword],
    initialPageParam: 1,
    queryFn: ({ pageParam }): Promise<SearchPage> =>
      view === "video"
        ? acfunVideoSearch(keyword, pageParam as number)
        : acfunArticleSearch(keyword, pageParam as number),
    enabled: keyword.length > 0,
    getNextPageParam: (last, pages) => {
      if (!last.has_more) return undefined;
      if (view === "video") {
        return (last as AcfunVideoListPage).next_page ?? undefined;
      }
      return pages.length + 1;
    },
    ...BROWSING_LIST_QUERY_OPTIONS,
  });
  const items = useMemo(
    () =>
      dedupeAcfunItems(
        query.data?.pages.flatMap(
          (page: SearchPage): readonly (AcfunVideoItem | AcfunArticleItem)[] => page.items,
        ) ?? [],
      ),
    [query.data],
  );
  const { loadMore, loadMoreRef } = useInfiniteScroll({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
  });
  const label = view === "video" ? "视频" : "文章";

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 pb-6">
      <h1 className="sr-only">搜索 AcFun {label}</h1>
      <div className="flex justify-end">
        <div className="h-10">
          <AcfunContentSwitcher
            value={view}
            onValueChange={(next) => navigate(acfunSearchPath(next, keyword))}
          />
        </div>
      </div>

      {keyword.length === 0 && (
        <Empty className="min-h-56 border-0 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search aria-hidden />
            </EmptyMedia>
            <EmptyTitle>输入关键词搜索</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}

      {keyword && query.isLoading && <AcfunGridSkeleton />}
      {query.isError && (
        <ErrorState
          error={query.error}
          title={`AcFun ${label}搜索失败`}
          onRetry={() => void query.refetch()}
        />
      )}
      {keyword && !query.isLoading && !query.isError && items.length === 0 && (
        <Empty className="min-h-56 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {view === "video" ? <Video aria-hidden /> : <BookOpenText aria-hidden />}
            </EmptyMedia>
            <EmptyTitle>没有找到匹配结果</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => navigate(acfunHomePath(view))}>
              返回{label}
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {items.length > 0 && <AcfunCardGrid kind={view} items={items} />}
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-2" role="status">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="正在加载" />
        </div>
      )}
      {query.isFetchNextPageError && (
        <ErrorState error={query.error} title="下一页加载失败" onRetry={() => loadMore(true)} />
      )}
      <div ref={loadMoreRef} className="h-px" aria-hidden />
    </div>
  );
}
