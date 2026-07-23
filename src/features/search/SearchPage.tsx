import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Loader2, Search } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { RoomCard } from "@/shared/components/RoomCard";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type { RoomListPage } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SITE_LABELS } from "@/lib/utils";

export function SearchPage() {
  const siteId = useSiteId();
  const [params] = useSearchParams();
  const keyword = (params.get("q") ?? "").trim();
  const [debounced, setDebounced] = useState(keyword);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(keyword), 200);
    return () => window.clearTimeout(t);
  }, [keyword]);

  const query = useInfiniteQuery({
    queryKey: ["search", siteId, debounced],
    queryFn: ({ pageParam }) =>
      invokeCmd<RoomListPage>("site_search_rooms", {
        siteId,
        keyword: debounced,
        page: pageParam,
      }),
    initialPageParam: 1,
    enabled: debounced.length > 0,
    getNextPageParam: (last, _pages, lastPageParam) =>
      last.has_more ? lastPageParam + 1 : undefined,
  });

  const rooms = query.data?.pages.flatMap((p) => p.items) ?? [];
  const siteLabel = SITE_LABELS[siteId] ?? siteId;

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      {debounced.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <Search className="h-8 w-8 opacity-30" />
          <p className="text-sm">在右上角输入关键词搜索 {siteLabel} 直播间</p>
        </div>
      )}

      {debounced.length > 0 && query.isLoading && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-video w-full rounded-xl" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      )}

      {debounced.length > 0 && query.isError && (
        <ErrorState
          error={query.error}
          title="搜索失败"
          onRetry={() => void query.refetch()}
        />
      )}

      {debounced.length > 0 &&
        !query.isLoading &&
        !query.isError &&
        rooms.length === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">
            没有找到与「{debounced}」相关的直播间
          </p>
        )}

      {rooms.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {rooms.map((room) => (
            <RoomCard key={`${room.site_id}:${room.room_id}`} room={room} />
          ))}
        </div>
      )}

      {query.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? (
              <>
                <Loader2 className="animate-spin-soft" />
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
