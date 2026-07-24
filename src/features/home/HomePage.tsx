import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { RoomCard } from "@/shared/components/RoomCard";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type { RoomListPage } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SITE_LABELS } from "@/lib/utils";

export function HomePage() {
  const siteId = useSiteId();

  const query = useInfiniteQuery({
    queryKey: ["recommend", siteId],
    queryFn: ({ pageParam }) =>
      invokeCmd<RoomListPage>("site_get_recommend", {
        siteId,
        page: pageParam,
      }),
    initialPageParam: 1,
    getNextPageParam: (last, _pages, lastPageParam) =>
      last.has_more ? lastPageParam + 1 : undefined,
  });

  const rooms = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div key={siteId} className="mx-auto flex max-w-[1600px] flex-col gap-4 motion-safe:animate-platform-enter">
      {query.isLoading && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="aspect-video w-full rounded-xl" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      )}

      {query.isError && (
        <ErrorState
          error={query.error}
          title="推荐直播加载失败"
          onRetry={() => void query.refetch()}
        />
      )}

      {!query.isLoading && !query.isError && rooms.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-24 text-muted-foreground">
          <p className="text-sm">
            暂无 {SITE_LABELS[siteId] ?? siteId} 推荐直播
          </p>
        </div>
      )}

      {rooms.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {rooms.map((room) => (
            <RoomCard key={`${room.site_id}:${room.room_id}`} room={room} />
          ))}
        </div>
      )}

      {query.hasNextPage && (
        <div className="flex justify-center pt-3 pb-2">
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
