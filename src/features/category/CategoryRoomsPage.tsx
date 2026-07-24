import { useLayoutEffect, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import { RoomCard } from "@/shared/components/RoomCard";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type { LiveCategory, LiveSubCategory, RoomListPage } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { categoryNameFromSearch } from "./categoryRoute";

function fallbackCategory(parentId: string, categoryId: string, name: string): LiveSubCategory {
  return {
    id: categoryId,
    name: name || "分区直播",
    parent_id: parentId,
    pic: null,
  };
}

function resolveCategory(
  categories: LiveCategory[],
  parentId: string,
  categoryId: string,
  name: string,
): LiveSubCategory {
  const parent = categories.find((item) => item.id === parentId);
  const child = parent?.children.find((item) => item.id === categoryId);
  if (child) return child;
  if (parent && categoryId === "0") {
    return {
      id: "0",
      name: `全部${parent.name}`,
      parent_id: parent.id,
      pic: null,
    };
  }
  return fallbackCategory(parentId, categoryId, name);
}

export function CategoryRoomsPage() {
  const navigate = useNavigate();
  const siteId = useSiteId();
  const { parentId = "", categoryId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const categoryName = categoryNameFromSearch(searchParams.get("name"));

  const categoriesQuery = useQuery({
    queryKey: ["categories", siteId],
    queryFn: () => invokeCmd<LiveCategory[]>("site_get_categories", { siteId }),
  });

  const category = useMemo(
    () => resolveCategory(categoriesQuery.data ?? [], parentId, categoryId, categoryName),
    [categoriesQuery.data, categoryId, categoryName, parentId],
  );

  const roomsQuery = useInfiniteQuery({
    queryKey: ["category_rooms", siteId, parentId, categoryId],
    queryFn: ({ pageParam }) =>
      invokeCmd<RoomListPage>("site_get_category_rooms", {
        siteId,
        category,
        page: pageParam,
      }),
    initialPageParam: 1,
    enabled: Boolean(parentId && categoryId),
    getNextPageParam: (last, _pages, lastPageParam) =>
      last.has_more ? lastPageParam + 1 : undefined,
  });

  const rooms = useMemo(
    () => roomsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [roomsQuery.data],
  );

  // Shell owns the scrolling element. A dedicated route should always start at
  // its top instead of inheriting the category browser's previous scroll spot.
  useLayoutEffect(() => {
    document.querySelector<HTMLElement>("main")?.scrollTo({ top: 0 });
  }, [categoryId, parentId, siteId]);

  return (
    <div className="mx-auto max-w-[1600px] pb-6">
      <PageHeader
        title={category.name}
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate("/category")}>
            <ArrowLeft data-icon="inline-start" />
            分区
          </Button>
        }
      />

      {roomsQuery.isLoading && <RoomGridSkeleton />}

      {roomsQuery.isError && (
        <ErrorState
          error={roomsQuery.error}
          title={`加载「${category.name}」失败`}
          onRetry={() => void roomsQuery.refetch()}
        />
      )}

      {!roomsQuery.isLoading && !roomsQuery.isError && rooms.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">暂无直播</p>
      )}

      {rooms.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {rooms.map((room) => (
            <RoomCard key={`${room.site_id}:${room.room_id}`} room={room} />
          ))}
        </div>
      )}

      {roomsQuery.hasNextPage && (
        <div className="flex justify-center pt-4">
          <Button
            variant="secondary"
            disabled={roomsQuery.isFetchingNextPage}
            onClick={() => void roomsQuery.fetchNextPage()}
          >
            {roomsQuery.isFetchingNextPage ? (
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

function RoomGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
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
