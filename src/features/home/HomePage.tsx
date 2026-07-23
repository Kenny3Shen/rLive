import { useInfiniteQuery } from "@tanstack/react-query";
import { invokeCmd } from "../../shared/api/tauri";
import { ErrorState } from "../../shared/components/ErrorState";
import { RoomCard } from "../../shared/components/RoomCard";
import { useSiteId } from "../../shared/hooks/useSiteQuery";
import type { RoomListPage } from "../../shared/types/live";

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
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">Home</h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Recommended · {siteId}
        </p>
      </div>

      {query.isLoading && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading rooms…</p>
      )}

      {query.isError && (
        <ErrorState
          error={query.error}
          title="Failed to load recommendations"
          onRetry={() => void query.refetch()}
        />
      )}

      {!query.isLoading && !query.isError && rooms.length === 0 && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No rooms found.</p>
      )}

      {rooms.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {rooms.map((room) => (
            <RoomCard key={`${room.site_id}:${room.room_id}`} room={room} />
          ))}
        </div>
      )}

      {query.hasNextPage && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
