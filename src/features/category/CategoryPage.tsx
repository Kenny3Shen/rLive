import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { RoomCard } from "@/shared/components/RoomCard";
import { Chip } from "@/shared/components/Chip";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type {
  LiveCategory,
  LiveSubCategory,
  RoomListPage,
} from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function CategoryPage() {
  const siteId = useSiteId();
  const [parentId, setParentId] = useState<string | null>(null);
  const [subCategory, setSubCategory] = useState<LiveSubCategory | null>(null);

  const categoriesQuery = useQuery({
    queryKey: ["categories", siteId],
    queryFn: () => invokeCmd<LiveCategory[]>("site_get_categories", { siteId }),
  });

  const categories = categoriesQuery.data ?? [];

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
    <div className="mx-auto max-w-[1600px] space-y-4">
      {categoriesQuery.isLoading && (
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-full" />
          ))}
        </div>
      )}

      {categoriesQuery.isError && (
        <ErrorState
          error={categoriesQuery.error}
          title="分类加载失败"
          onRetry={() => void categoriesQuery.refetch()}
        />
      )}

      {categories.length > 0 && (
        <>
          <div
            className="flex flex-wrap gap-1.5"
            role="tablist"
            aria-label="一级分类"
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
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-ring",
                    active
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {cat.name}
                </button>
              );
            })}
          </div>

          {children.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="子分类">
              {children.map((child) => (
                <Chip
                  key={child.id}
                  active={child.id === subCategory?.id}
                  onClick={() => setSubCategory(child)}
                >
                  {child.name}
                </Chip>
              ))}
            </div>
          )}

          {subCategory && (
            <div className="space-y-3">
              {roomsQuery.isLoading && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="space-y-2">
                      <Skeleton className="aspect-video w-full rounded-xl" />
                      <Skeleton className="h-3.5 w-4/5" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  ))}
                </div>
              )}

              {roomsQuery.isError && (
                <ErrorState
                  error={roomsQuery.error}
                  title={`加载「${subCategory.name}」失败`}
                  onRetry={() => void roomsQuery.refetch()}
                />
              )}

              {!roomsQuery.isLoading &&
                !roomsQuery.isError &&
                rooms.length === 0 && (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    该分类下暂无直播
                  </p>
                )}

              {rooms.length > 0 && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
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
                  <Button
                    variant="secondary"
                    disabled={roomsQuery.isFetchingNextPage}
                    onClick={() => void roomsQuery.fetchNextPage()}
                  >
                    {roomsQuery.isFetchingNextPage ? (
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
          )}
        </>
      )}
    </div>
  );
}
