import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { invokeCmd } from "../../shared/api/tauri";
import { ErrorState } from "../../shared/components/ErrorState";
import { RoomCard } from "../../shared/components/RoomCard";
import { useSiteId } from "../../shared/hooks/useSiteQuery";
import type { LiveCategory, LiveSubCategory, RoomListPage } from "../../shared/types/live";

export function CategoryPage() {
  const siteId = useSiteId();
  const [parentId, setParentId] = useState<string | null>(null);
  const [subCategory, setSubCategory] = useState<LiveSubCategory | null>(null);

  const categoriesQuery = useQuery({
    queryKey: ["categories", siteId],
    queryFn: () => invokeCmd<LiveCategory[]>("site_get_categories", { siteId }),
  });

  const categories = categoriesQuery.data ?? [];

  // Reset selection when site changes or categories reload.
  useEffect(() => {
    setParentId(null);
    setSubCategory(null);
  }, [siteId]);

  useEffect(() => {
    if (categories.length === 0) return;
    if (!parentId || !categories.some((c) => c.id === parentId)) {
      setParentId(categories[0].id);
      setSubCategory(null);
    }
  }, [categories, parentId]);

  const parent = categories.find((c) => c.id === parentId) ?? null;
  const children = parent?.children ?? [];

  useEffect(() => {
    if (children.length === 0) {
      setSubCategory(null);
      return;
    }
    if (!subCategory || !children.some((c) => c.id === subCategory.id)) {
      setSubCategory(children[0]);
    }
  }, [children, subCategory]);

  const roomsQuery = useInfiniteQuery({
    queryKey: [
      "category_rooms",
      siteId,
      subCategory?.parent_id,
      subCategory?.id,
    ],
    queryFn: ({ pageParam }) =>
      invokeCmd<RoomListPage>("site_get_category_rooms", {
        siteId,
        category: subCategory,
        page: pageParam,
      }),
    initialPageParam: 1,
    enabled: !!subCategory,
    getNextPageParam: (last, _pages, lastPageParam) =>
      last.has_more ? lastPageParam + 1 : undefined,
  });

  const rooms = roomsQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Category</h1>

      {categoriesQuery.isLoading && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading categories…</p>
      )}

      {categoriesQuery.isError && (
        <ErrorState
          error={categoriesQuery.error}
          title="Failed to load categories"
          onRetry={() => void categoriesQuery.refetch()}
        />
      )}

      {categories.length > 0 && (
        <>
          {/* Parent categories */}
          <div
            className="flex flex-wrap gap-1.5"
            role="tablist"
            aria-label="Parent categories"
          >
            {categories.map((cat) => {
              const active = cat.id === parentId;
              return (
                <button
                  key={cat.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setParentId(cat.id);
                    setSubCategory(null);
                  }}
                  className={clsx(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    active
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700",
                  )}
                >
                  {cat.name}
                </button>
              );
            })}
          </div>

          {/* Sub-categories */}
          {children.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Sub-categories">
              {children.map((child) => {
                const active = child.id === subCategory?.id;
                return (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => setSubCategory(child)}
                    className={clsx(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      active
                        ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                        : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600",
                    )}
                  >
                    {child.name}
                  </button>
                );
              })}
            </div>
          )}

          {subCategory && (
            <div className="space-y-3">
              {roomsQuery.isLoading && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Loading rooms…
                </p>
              )}

              {roomsQuery.isError && (
                <ErrorState
                  error={roomsQuery.error}
                  title={`Failed to load ${subCategory.name}`}
                  onRetry={() => void roomsQuery.refetch()}
                />
              )}

              {!roomsQuery.isLoading && !roomsQuery.isError && rooms.length === 0 && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  No rooms in this category.
                </p>
              )}

              {rooms.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {rooms.map((room) => (
                    <RoomCard
                      key={`${room.site_id}:${room.room_id}`}
                      room={room}
                    />
                  ))}
                </div>
              )}

              {roomsQuery.hasNextPage && (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    disabled={roomsQuery.isFetchingNextPage}
                    onClick={() => void roomsQuery.fetchNextPage()}
                    className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {roomsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
