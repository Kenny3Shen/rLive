import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ListFilter, Loader2, Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { RoomCard } from "@/shared/components/RoomCard";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type { LiveRoomDetail, LiveRoomItem, RoomListPage } from "@/shared/types/live";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  parseSearchScope,
  prepareSearchResults,
  roomFromDetail,
  SEARCH_SCOPES,
  searchMatch,
  searchPath,
  searchScopeLabel,
  type SearchMatch,
  type SearchScope,
} from "./search";

const SEARCH_MATCH_LABELS: Record<SearchMatch, string> = {
  room: "房间号",
  user: "主播",
  title: "标题",
  related: "相关",
};

export function SearchPage() {
  const navigate = useNavigate();
  const siteId = useSiteId();
  const [params] = useSearchParams();
  const keyword = (params.get("q") ?? "").trim();
  const scope = parseSearchScope(params.get("scope"));
  const [draft, setDraft] = useState(keyword);
  const [draftScope, setDraftScope] = useState<SearchScope>(scope);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(keyword);
    setDraftScope(scope);
  }, [keyword, scope]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const roomLookup = useQuery({
    queryKey: ["search_room", siteId, keyword],
    queryFn: () =>
      invokeCmd<LiveRoomDetail>("site_get_room_detail", {
        siteId,
        roomId: keyword,
      }),
    enabled: scope === "room" && keyword.length > 0,
    retry: false,
  });

  // 对房间号而言直接查询既更快也更可靠。若某平台对别名的解析方式不同，
  // 再回退到其常规搜索接口。
  const useTextSearch = keyword.length > 0 && (scope !== "room" || roomLookup.isError);
  const textQuery = useInfiniteQuery({
    queryKey: ["search", siteId, keyword, scope],
    queryFn: ({ pageParam }) =>
      invokeCmd<RoomListPage>("site_search_rooms", {
        siteId,
        keyword,
        page: pageParam,
      }),
    initialPageParam: 1,
    enabled: useTextSearch,
    getNextPageParam: (last, _pages, lastPageParam) =>
      last.has_more ? lastPageParam + 1 : undefined,
  });

  const textRooms = useMemo(
    () =>
      prepareSearchResults(
        textQuery.data?.pages.flatMap((page) => page.items) ?? [],
        keyword,
        scope,
      ),
    [keyword, scope, textQuery.data],
  );
  const rooms = useMemo<LiveRoomItem[]>(
    () => (scope === "room" && roomLookup.data ? [roomFromDetail(roomLookup.data)] : textRooms),
    [roomLookup.data, scope, textRooms],
  );

  const isLoading =
    keyword.length > 0 &&
    (scope === "room"
      ? roomLookup.isLoading || (roomLookup.isError && textQuery.isLoading)
      : textQuery.isLoading);
  const isError = scope === "room" ? roomLookup.isError && textQuery.isError : textQuery.isError;
  const error = textQuery.error ?? roomLookup.error;
  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    hasNextPage: textQuery.hasNextPage,
    isFetchingNextPage: textQuery.isFetchingNextPage,
    isFetchNextPageError: textQuery.isFetchNextPageError,
    fetchNextPage: textQuery.fetchNextPage,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(searchPath(draft, draftScope));
  }

  function changeScope(next: SearchScope) {
    setDraftScope(next);
    if (keyword) navigate(searchPath(keyword, next));
  }

  function retry() {
    if (scope === "room") {
      void roomLookup.refetch();
      void textQuery.refetch();
      return;
    }
    void textQuery.refetch();
  }

  const scopeLabel = searchScopeLabel(scope);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 pb-6">
      <form onSubmit={submit} className="flex w-full max-w-3xl items-center gap-2">
        <Input
          ref={inputRef}
          id="search-keyword"
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入主播、房间号或标题"
          autoComplete="off"
          aria-label="搜索关键词"
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="icon" aria-label="搜索" title="搜索">
          <Search aria-hidden />
        </Button>
        <Select
          value={draftScope}
          onValueChange={(value) => {
            if (!value) return;
            const next = parseSearchScope(value);
            if (next !== draftScope) changeScope(next);
          }}
        >
          <SelectTrigger
            size="default"
            aria-label={`筛选搜索字段：${searchScopeLabel(draftScope)}`}
            title={`筛选搜索字段：${searchScopeLabel(draftScope)}`}
            className="shrink-0 border border-input bg-background"
          >
            <ListFilter data-icon="inline-start" aria-hidden />
            <SelectValue>{searchScopeLabel(draftScope)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end" className="min-w-32">
            <SelectGroup>
              {SEARCH_SCOPES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </form>

      {keyword.length === 0 && (
        <Empty className="min-h-56 border-0 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search aria-hidden />
            </EmptyMedia>
            <EmptyTitle>输入关键词开始搜索</EmptyTitle>
            <EmptyDescription>可按主播、房间号或标题查找直播间。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {isLoading && <SearchGridSkeleton />}

      {isError && <ErrorState error={error} title="搜索失败" onRetry={retry} />}

      {keyword.length > 0 && !isLoading && !isError && rooms.length === 0 && (
        <Empty className="min-h-56 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search aria-hidden />
            </EmptyMedia>
            <EmptyTitle>没有找到匹配结果</EmptyTitle>
            <EmptyDescription>
              未找到“{keyword}”的{scopeLabel}结果，试试更短的关键词或其他搜索方式。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={() => navigate("/search")}>
              清除搜索
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {rooms.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            当前 {rooms.length} 项 · 按{scopeLabel}
          </p>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {rooms.map((room) => {
              const match: SearchMatch = scope === "all" ? searchMatch(room, keyword) : scope;
              return (
                <li key={`${room.site_id}:${room.room_id}`} className="flex flex-col gap-1.5">
                  <RoomCard room={room} />
                  <div className="flex items-center gap-1.5 px-0.5">
                    <Badge variant="outline">{SEARCH_MATCH_LABELS[match]}</Badge>
                    <span className="truncate text-xs text-muted-foreground">
                      房间 {room.room_id}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {textQuery.hasNextPage && (
        <div ref={loadMoreRef} className="flex min-h-11 items-center justify-center pt-3 pb-2">
          {textQuery.isFetchingNextPage && (
            <span
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="animate-spin-soft" data-icon="inline-start" />
              加载中…
            </span>
          )}
          {textQuery.isFetchNextPageError && (
            <Button variant="secondary" onClick={() => loadMore(true)}>
              重试加载
            </Button>
          )}
          {!supportsIntersectionObserver &&
            !textQuery.isFetchingNextPage &&
            !textQuery.isFetchNextPageError && (
              <Button variant="secondary" onClick={() => loadMore()}>
                加载更多
              </Button>
            )}
        </div>
      )}
    </div>
  );
}

function SearchGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
