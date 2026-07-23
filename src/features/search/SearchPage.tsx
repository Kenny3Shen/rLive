import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { invokeCmd } from "../../shared/api/tauri";
import { ErrorState } from "../../shared/components/ErrorState";
import { RoomCard } from "../../shared/components/RoomCard";
import { useSiteId } from "../../shared/hooks/useSiteQuery";
import type { RoomListPage } from "../../shared/types/live";

const DEBOUNCE_MS = 350;

export function SearchPage() {
  const siteId = useSiteId();
  const [input, setInput] = useState("");
  const [keyword, setKeyword] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => {
      setKeyword(input.trim());
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [input]);

  const query = useInfiniteQuery({
    queryKey: ["search", siteId, keyword],
    queryFn: ({ pageParam }) =>
      invokeCmd<RoomListPage>("site_search_rooms", {
        siteId,
        keyword,
        page: pageParam,
      }),
    initialPageParam: 1,
    enabled: keyword.length > 0,
    getNextPageParam: (last, _pages, lastPageParam) =>
      last.has_more ? lastPageParam + 1 : undefined,
  });

  const rooms = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Search</h1>

      <div className="max-w-xl">
        <label htmlFor="room-search" className="sr-only">
          Search live rooms
        </label>
        <input
          id="room-search"
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Search ${siteId} rooms…`}
          autoComplete="off"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
        />
        {input !== keyword && input.trim().length > 0 && (
          <p className="mt-1 text-xs text-zinc-400">Searching…</p>
        )}
      </div>

      {keyword.length === 0 && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Type a keyword to search live rooms.
        </p>
      )}

      {keyword.length > 0 && query.isLoading && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Searching…</p>
      )}

      {keyword.length > 0 && query.isError && (
        <ErrorState
          error={query.error}
          title="Search failed"
          onRetry={() => void query.refetch()}
        />
      )}

      {keyword.length > 0 &&
        !query.isLoading &&
        !query.isError &&
        rooms.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No results for “{keyword}”.
          </p>
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
