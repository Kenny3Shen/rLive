import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, LayoutGrid } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { invokeCmd } from "@/shared/api/tauri";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import { PageEnter, PageEnterItem } from "@/shared/motion/PageEnter";
import type { LiveCategory, LiveSubCategory } from "@/shared/types/live";
import { Skeleton } from "@/components/ui/skeleton";
import { categoryRoomsPath } from "./categoryRoute";
import { normalizeImageUrl } from "@/lib/utils";

const INITIAL_CATEGORY_COUNT = 12;

function allCategory(category: LiveCategory): LiveSubCategory {
  return {
    id: "0",
    name: `全部${category.name}`,
    parent_id: category.id,
    pic: null,
  };
}

type CategoryTileProps = {
  category: LiveSubCategory;
  onClick: () => void;
};

function CategoryTile({ category, onClick }: CategoryTileProps) {
  const iconSrc = normalizeImageUrl(category.pic);

  return (
    <button
      type="button"
      title={`查看${category.name}`}
      onClick={onClick}
      className="group flex w-full max-w-24 flex-col items-center gap-2 rounded-xl px-1 py-1.5 text-center text-foreground transition-colors hover:bg-muted/65 focus-ring"
    >
      <span className="relative flex size-10 items-center justify-center overflow-hidden rounded-lg bg-muted ring-1 ring-border-subtle">
        <LayoutGrid className="size-5 text-muted-foreground" aria-hidden />
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
      <span className="line-clamp-2 min-h-8 text-xs leading-4 font-medium">{category.name}</span>
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
      <span className="flex size-10 items-center justify-center rounded-lg bg-muted ring-1 ring-border-subtle transition-colors group-hover:bg-sidebar-active">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="min-h-8 text-xs leading-4 font-medium">
        {expanded ? "收起" : "显示全部"}
      </span>
    </button>
  );
}

export function CategoryPage() {
  const navigate = useNavigate();
  const siteId = useSiteId();
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => new Set());

  const categoriesQuery = useQuery({
    queryKey: ["categories", siteId],
    queryFn: () => invokeCmd<LiveCategory[]>("site_get_categories", { siteId }),
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const categories = categoriesQuery.data ?? [];

  useEffect(() => {
    setExpandedParents(new Set());
  }, [siteId]);

  function toggleParent(parentId: string) {
    setExpandedParents((current) => {
      const next = new Set(current);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }

  return (
    <PullToRefresh
      onRefresh={() => categoriesQuery.refetch()}
      refreshing={categoriesQuery.isRefetching}
      className="mx-auto max-w-[1600px]"
    >
      <RefreshFab
        onRefresh={() => categoriesQuery.refetch()}
        pending={categoriesQuery.isRefetching || categoriesQuery.isLoading}
        label="刷新分类"
      />
      <div className="pb-6">
        <h1 className="sr-only">分类</h1>
        {categoriesQuery.isLoading && <CategorySkeleton />}

        {categoriesQuery.isError && (
          <ErrorState
            error={categoriesQuery.error}
            title="分类加载失败"
            onRetry={() => void categoriesQuery.refetch()}
          />
        )}

        {categories.length > 0 && (
          // Parent sections are the staggered units; `maxItems` keeps a long
          // category list from animating every section on a platform switch.
          // Keyed by platform because Shell's page wrapper no longer is: the
          // scroller persists across a site switch, so the replay of this
          // stagger has to be requested here rather than inherited from a
          // route-level remount.
          <PageEnter key={siteId} ready maxItems={8} className="flex flex-col gap-9">
            {categories.map((parent, index) => {
              const expanded = expandedParents.has(parent.id);
              const children = parent.children.some((child) => child.id === "0")
                ? parent.children
                : [allCategory(parent), ...parent.children];
              const visibleChildren = expanded
                ? children
                : children.slice(0, INITIAL_CATEGORY_COUNT);
              const canExpand = children.length > INITIAL_CATEGORY_COUNT;

              return (
                <PageEnterItem index={index} key={parent.id}>
                  <section aria-labelledby={`category-${parent.id}`}>
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
                          onClick={() => navigate(categoryRoomsPath(child))}
                        />
                      ))}
                      {canExpand && (
                        <ExpandTile expanded={expanded} onClick={() => toggleParent(parent.id)} />
                      )}
                    </div>
                  </section>
                </PageEnterItem>
              );
            })}
          </PageEnter>
        )}
      </div>
    </PullToRefresh>
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
              <div key={tileIndex} className="flex w-full max-w-24 flex-col gap-2 px-1 py-1.5">
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
