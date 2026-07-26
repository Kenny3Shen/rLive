import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import { RoomCard } from "@/shared/components/RoomCard";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type { LiveRoomDetail, LiveRoomItem, RoomListPage } from "@/shared/types/live";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  parseSearchScope,
  canSearchNavigateBack,
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

  // A direct lookup is both faster and more reliable for a room number. If a
  // platform resolves aliases differently, fall back to its normal search API.
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(searchPath(draft, draftScope));
  }

  function changeScope(next: SearchScope) {
    setDraftScope(next);
    if (keyword) navigate(searchPath(keyword, next));
  }

  function goBack() {
    if (canSearchNavigateBack(window.history.state)) {
      navigate(-1);
      return;
    }
    navigate("/", { replace: true });
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
      <PageHeader
        title="搜索"
        description="主播、房间号、标题"
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="返回上一页"
            title="返回上一页"
            onClick={goBack}
          >
            <ArrowLeft data-icon="inline-start" aria-hidden />
            返回
          </Button>
        }
      />

      <form onSubmit={submit} className="max-w-2xl">
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel className="sr-only" htmlFor="search-keyword">
              搜索关键词
            </FieldLabel>
            <Input
              ref={inputRef}
              id="search-keyword"
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="输入主播、房间号或标题"
              autoComplete="off"
              className="min-w-0 flex-1"
            />
            <Button type="submit" className="shrink-0">
              <Search data-icon="inline-start" />
              搜索
            </Button>
          </Field>
        </FieldGroup>
      </form>

      <ToggleGroup
        aria-label="搜索方式"
        value={[draftScope]}
        variant="outline"
        size="sm"
        spacing={1}
        onValueChange={(values) => {
          const value = values[0];
          if (!value) return;
          const next = parseSearchScope(value);
          if (next !== draftScope) changeScope(next);
        }}
      >
        {SEARCH_SCOPES.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value}>
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {keyword.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <Search className="size-8 opacity-30" aria-hidden />
          <p className="text-sm">输入关键词开始搜索</p>
        </div>
      )}

      {isLoading && <SearchGridSkeleton />}

      {isError && <ErrorState error={error} title="搜索失败" onRetry={retry} />}

      {keyword.length > 0 && !isLoading && !isError && rooms.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          未找到「{keyword}」的{scopeLabel}结果
        </p>
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
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            disabled={textQuery.isFetchingNextPage}
            onClick={() => void textQuery.fetchNextPage()}
          >
            {textQuery.isFetchingNextPage ? (
              <>
                <Loader2 className="animate-spin-soft" data-icon="inline-start" />
                加载中…
              </>
            ) : (
              "加载更多"
            )}
          </Button>
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
