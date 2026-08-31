import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, Sparkles } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { invokeCmd } from "@/shared/api/tauri";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type { LiveCategory, LiveSubCategory } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CATEGORY_PARAM,
  CATEGORY_PUSH_STATE,
  categoryChipKey,
  homeCategoryPath,
  isCategoryPushEntry,
  parseCategorySelection,
} from "./categorySelection";
import { CategoryGroups } from "./CategoryPanel";

/**
 * 桌面端的「全部分类」页。
 *
 * 分区浏览是一次独立的取向动作：一屏几百个分区，铺在首页内容栏里会把房间网格
 * 推到折叠之下，用户想回到刚才那一屏还得自己找路。因此它照搜索页的模式占一条
 * 自己的路由 —— 有返回栈、可分享、可预加载。触摸客户端不来这里，它用首页上的
 * 底部抽屉（见 `CategoryPanel`），那边拇指可达且能接系统返回键。
 *
 * 选中分区后回首页，分区房间在那里同页替换推荐流。用 replace 而不是 push：
 * 这一页是过渡用的取向表面，留在历史里会让「返回」先退回一屏分类墙，
 * 而用户此刻想要的是上一个浏览位置。
 */
export function CategoryBrowsePage() {
  const siteId = useSiteId();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // 从首页带过来的当前选中态，用于在分类墙里回显「你正在看哪个分区」。
  const selection = parseCategorySelection(searchParams.get(CATEGORY_PARAM), siteId);
  const selectedKey = selection ? categoryChipKey(selection.parentId, selection.categoryId) : null;

  const categoriesQuery = useQuery({
    queryKey: ["categories", siteId],
    queryFn: () => invokeCmd<LiveCategory[]>("site_get_categories", { siteId }),
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const categories = categoriesQuery.data;

  function select(category: LiveSubCategory) {
    // replace 掉的正是本页这条记录，因此新的分区态记录继承本页的 push 标记：标记的
    // 含义是「紧下面压着的是推荐态首页」，而 replace 不改变下面压着谁。带上它，首页
    // 那边点「推荐」才会走系统回退而不是再压一条记录。
    navigate(homeCategoryPath({ siteId, parentId: category.parent_id, categoryId: category.id }), {
      replace: true,
      state: isCategoryPushEntry(location.state) ? CATEGORY_PUSH_STATE : undefined,
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
        <h1 className="sr-only">全部分类</h1>

        {categoriesQuery.isLoading && <CategorySkeleton />}

        {categoriesQuery.isError && (
          <ErrorState
            error={categoriesQuery.error}
            title="分类加载失败"
            onRetry={() => void categoriesQuery.refetch()}
          />
        )}

        {categories &&
          categories.length > 0 && (
            // 换平台就换掉整棵分类树，上一平台展开过的父分区 id 在新树里没有意义。
            // 用 key 丢弃子树状态，而不是在副作用里补一次 setState。
            <CategoryGroups
              key={siteId}
              categories={categories}
              selectedKey={selectedKey}
              onSelect={select}
            />
          )}

        {/* 请求成功但树是空的（平台改版、接口降级）。这不是错误，别摆重试按钮当主
            操作 —— 推荐流仍然可用，把用户送回去比让他反复重试有用。 */}
        {categories && categories.length === 0 && (
          <Empty className="min-h-64 py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayoutGrid aria-hidden />
              </EmptyMedia>
              <EmptyTitle>这个平台暂时没有分区</EmptyTitle>
              <EmptyDescription>回首页看推荐，或稍后再来刷新。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={() => navigate("/", { replace: true })}>
                <Sparkles data-icon="inline-start" aria-hidden />
                回到推荐
              </Button>
            </EmptyContent>
          </Empty>
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
