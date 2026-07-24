import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, LayoutGrid, Loader2, X } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { RoomCard } from "@/shared/components/RoomCard";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type {
  LiveCategory,
  LiveSubCategory,
  RoomListPage,
} from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, normalizeImageUrl } from "@/lib/utils";

// Simple Live shows the "全部…" entry plus eleven concrete categories before
// offering the compact “显示全部” affordance.
const INITIAL_CATEGORY_COUNT = 12;

function allCategory(category: LiveCategory): LiveSubCategory {
  return {
    id: "0",
    name: `全部${category.name}`,
    parent_id: category.id,
    pic: null,
  };
}

function isSameCategory(
  left: LiveSubCategory | null,
  right: LiveSubCategory,
) {
  return left?.parent_id === right.parent_id && left.id === right.id;
}

type CategoryTileProps = {
  category: LiveSubCategory;
  active: boolean;
  onClick: () => void;
};

function CategoryTile({ category, active, onClick }: CategoryTileProps) {
  const iconSrc = normalizeImageUrl(category.pic);

  return (
    <button
      type="button"
      aria-pressed={active}
      title={category.name}
      onClick={onClick}
      className={cn(
        "group flex w-full max-w-24 flex-col items-center gap-2 rounded-xl px-1 py-1.5 text-center transition-colors focus-ring",
        active
          ? "bg-sidebar-active text-foreground shadow-inner"
          : "text-foreground hover:bg-muted/65",
      )}
    >
      <span className="relative flex size-10 items-center justify-center overflow-hidden rounded-lg bg-muted ring-1 ring-white/5">
        <LayoutGrid
          className={cn(
            "size-5 text-muted-foreground transition-colors",
            active && "text-primary",
          )}
          aria-hidden
        />
        {iconSrc && (
          <img
            src={iconSrc}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
            className="absolute inset-0 size-full object-cover"
          />
        )}
      </span>
      <span className="line-clamp-2 min-h-8 text-xs leading-4 font-medium">
        {category.name}
      </span>
    </button>
  );
}

type ExpandTileProps = {
  expanded: boolean;
  onClick: () => void;
};

function ExpandTile({ expanded, onClick }: ExpandTileProps) {
  const Icon = expanded ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full max-w-24 flex-col items-center gap-2 rounded-xl px-1 py-1.5 text-center text-muted-foreground transition-colors hover:bg-muted/65 hover:text-foreground focus-ring"
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-muted ring-1 ring-white/5 transition-colors group-hover:bg-sidebar-active">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="min-h-8 text-xs leading-4 font-medium">
        {expanded ? "收起" : "显示全部"}
      </span>
    </button>
  );
}

export function CategoryPage() {
  const siteId = useSiteId();
  const [selectedCategory, setSelectedCategory] =
    useState<LiveSubCategory | null>(null);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(
    () => new Set(),
  );

  const categoriesQuery = useQuery({
    queryKey: ["categories", siteId],
    queryFn: () => invokeCmd<LiveCategory[]>("site_get_categories", { siteId }),
  });

  const categories = categoriesQuery.data ?? [];

  useEffect(() => {
    setSelectedCategory(null);
    setExpandedParents(new Set());
  }, [siteId]);

  const roomsQuery = useInfiniteQuery({
    queryKey: [
      "category_rooms",
      siteId,
      selectedCategory?.parent_id,
      selectedCategory?.id,
    ],
    queryFn: ({ pageParam }) =>
      invokeCmd<RoomListPage>("site_get_category_rooms", {
        siteId,
        category: selectedCategory,
        page: pageParam,
      }),
    initialPageParam: 1,
    enabled: !!selectedCategory,
    getNextPageParam: (last, _pages, lastPageParam) =>
      last.has_more ? lastPageParam + 1 : undefined,
  });

  const rooms = useMemo(
    () => roomsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [roomsQuery.data],
  );

  function chooseCategory(category: LiveSubCategory) {
    setSelectedCategory((current) =>
      isSameCategory(current, category) ? null : category,
    );
  }

  function toggleParent(parentId: string) {
    setExpandedParents((current) => {
      const next = new Set(current);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-[1600px] pb-6">
      {categoriesQuery.isLoading && <CategorySkeleton />}

      {categoriesQuery.isError && (
        <ErrorState
          error={categoriesQuery.error}
          title="分类加载失败"
          onRetry={() => void categoriesQuery.refetch()}
        />
      )}

      {categories.length > 0 && (
        <div className="flex flex-col gap-9">
          {categories.map((parent) => {
            const expanded = expandedParents.has(parent.id);
            // Bilibili normally supplies id "0" itself. Keep a graceful
            // fallback for older/cache responses that omit that useful entry.
            const children = parent.children.some((child) => child.id === "0")
              ? parent.children
              : [allCategory(parent), ...parent.children];
            const visibleChildren = expanded
              ? children
              : children.slice(0, INITIAL_CATEGORY_COUNT);
            const canExpand = children.length > INITIAL_CATEGORY_COUNT;

            return (
              <section key={parent.id} aria-labelledby={`category-${parent.id}`}>
                <h2
                  id={`category-${parent.id}`}
                  className="mb-4 text-xl font-semibold tracking-tight text-foreground"
                >
                  {parent.name}
                </h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(74px,1fr))] justify-items-center gap-x-5 gap-y-4">
                  {visibleChildren.map((child) => (
                    <CategoryTile
                      key={child.id}
                      category={child}
                      active={isSameCategory(selectedCategory, child)}
                      onClick={() => chooseCategory(child)}
                    />
                  ))}
                  {canExpand && (
                    <ExpandTile
                      expanded={expanded}
                      onClick={() => toggleParent(parent.id)}
                    />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {selectedCategory && (
        <section
          className="mt-10 border-t border-border-subtle pt-5"
          aria-labelledby="selected-category-rooms"
        >
          <div className="mb-4 flex items-center gap-2">
            <h2
              id="selected-category-rooms"
              className="text-lg font-semibold tracking-tight"
            >
              {selectedCategory.name}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedCategory(null)}
            >
              <X data-icon="inline-start" />
              收起直播
            </Button>
          </div>

          {roomsQuery.isLoading && <RoomGridSkeleton />}

          {roomsQuery.isError && (
            <ErrorState
              error={roomsQuery.error}
              title={`加载「${selectedCategory.name}」失败`}
              onRetry={() => void roomsQuery.refetch()}
            />
          )}

          {!roomsQuery.isLoading && !roomsQuery.isError && rooms.length === 0 && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              该分类下暂无直播
            </p>
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
        </section>
      )}
    </div>
  );
}

function CategorySkeleton() {
  return (
    <div className="flex flex-col gap-9">
      {Array.from({ length: 3 }).map((_, sectionIndex) => (
        <section key={sectionIndex}>
          <Skeleton className="mb-4 h-6 w-20" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(74px,1fr))] justify-items-center gap-x-5 gap-y-4">
            {Array.from({ length: 12 }).map((_, tileIndex) => (
              <div key={tileIndex} className="flex w-full max-w-24 flex-col items-center gap-2 px-1 py-1.5">
                <Skeleton className="size-10 rounded-lg" />
                <Skeleton className="h-3 w-14" />
              </div>
            ))}
          </div>
        </section>
      ))}
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
