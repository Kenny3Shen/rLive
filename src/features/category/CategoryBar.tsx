import { useEffect, useRef } from "react";
import { LayoutGrid, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import type { LiveCategory, LiveSubCategory } from "@/shared/types/live";
import { cn } from "@/lib/utils";
import {
  categoryChipKey,
  categoryChips,
  hasHiddenCategories,
  type CategorySelection,
} from "./categorySelection";

/** 「推荐」项的 chip key。它不对应任何分区，因此不能走 `categoryChipKey`。 */
const RECOMMEND_KEY = "__recommend__";

type CategoryBarProps = {
  categories: readonly LiveCategory[];
  selection: CategorySelection | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** 传 null 表示回到推荐流。 */
  onSelect: (category: LiveSubCategory | null) => void;
  /**
   * 展开态。传 undefined 表示入口是一次导航而不是一个折叠面板 —— 桌面端点它会
   * 跳到 `/category`，此时不该声明 `aria-expanded`，那个属性承诺的是「按下后
   * 在原地展开一块内容」。
   */
  panelExpanded: boolean | undefined;
  onPanelEntry: () => void;
  /**
   * 指针/焦点落到入口上时触发，用于预加载目的地的路由模块。仅在入口是导航时
   * 有意义，抽屉形态传 undefined —— 那份代码随首页一起进包，没有东西可预取。
   */
  onPanelEntryIntent?: (() => void) | undefined;
};

/**
 * 首页顶部的 sticky 分区条。
 *
 * chips 纯文字、不带分类图标：图标会把条带高度撑到两倍，而这条东西整个浏览过程都
 * 钉在顶部，省下的每一像素都直接还给房间网格。图标留给展开面板，那里磁贴本来就
 * 有空间承载它们。
 *
 * 分类树失败时降级成只有「推荐」加一个重试按钮。分区是发现表面的加分项，
 * 推荐流才是首页的主体，不能让一次分类请求失败把整页拖下水。
 */
export function CategoryBar({
  categories,
  selection,
  loading,
  error,
  onRetry,
  onSelect,
  panelExpanded,
  onPanelEntry,
  onPanelEntryIntent,
}: CategoryBarProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const chips = categoryChips(categories, selection);
  const selectedKey = selection
    ? categoryChipKey(selection.parentId, selection.categoryId)
    : RECOMMEND_KEY;
  const showPanelEntry = hasHiddenCategories(categories);

  // 选中项滑进视野。这里刻意不用 `scrollIntoView`：它会沿祖先链向上冒泡去滚动
  // 每一层可滚动祖先，而 Shell 的平台滑动 viewport 正是其中一层 —— 它虽然是
  // `overflow: hidden`，但 hidden 容器依然可被程序化滚动。模拟器实测：居中一个靠
  // 右的 chip 会把 viewport 带走 101px，相邻平台的面板从边上露出来、当前平台的
  // 房间网格被裁掉一条，看起来像轨道对齐坏了。
  //
  // 直接写自己的 `scrollLeft` 没有这个副作用，纵向位置也完全不受影响（原先还要靠
  // `block: "nearest"` 才能避免把页面纵向滚动容器一起对齐）。用 rect 差值算目标位置
  // 而不用 `offsetLeft`，免得依赖 `offsetParent` 恰好是哪一层。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>('[data-category-chip-active="true"]');
    if (!active) return;
    const stripBox = strip.getBoundingClientRect();
    const activeBox = active.getBoundingClientRect();
    const delta = activeBox.left - stripBox.left - (stripBox.width - activeBox.width) / 2;
    strip.scrollTo({
      left: strip.scrollLeft + delta,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [selectedKey]);

  return (
    <div
      // sticky 的坑：Shell 的滚动容器带 `p-4 md:p-5`，`top-0` 会把条带钉在内边距
      // *下方*，房间封面从上面那条缝里穿过去。用负外边距把条带撑到容器边缘、
      // 再用同量内边距把内容推回原位，并把 `top` 设成负的内边距值，使黏停位置
      // 落在容器真正的上沿。两者必须配对：只给负外边距，条带会停在缝下面。
      className={cn(
        "sticky z-20 -mx-4 -mt-4 px-4 md:-mx-5 md:-mt-5 md:px-5",
        "top-[-1rem] md:top-[-1.25rem]",
        // 实心背景，不用半透明+模糊：房间封面在下面滚过时会糊成一片彩色噪点，
        // 文字对比度随内容变化而不可控。
        "border-b border-border-subtle bg-background",
      )}
    >
      <div className="flex items-center gap-2 py-2.5">
        <div
          ref={stripRef}
          // 纵向滚动仍归页面，横向留给这条 strip；同时声明成横滑手势的自有表面，
          // 使 Shell 的平台切换手势不会把这里的横向滚动抢走。
          data-horizontal-swipe-surface
          className="-mx-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1 py-0.5 touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <CategoryChipButton
            label="推荐"
            active={selectedKey === RECOMMEND_KEY}
            aggregate
            onClick={() => onSelect(null)}
          />

          {loading && !error && (
            <>
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-7 w-16 shrink-0 rounded-full" />
              ))}
            </>
          )}

          {!error &&
            chips.map((chip) => (
              <CategoryChipButton
                key={chip.key}
                label={chip.label}
                active={chip.key === selectedKey}
                aggregate={chip.aggregate}
                onClick={() => onSelect(chip.category)}
              />
            ))}

          {error && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 rounded-full text-muted-foreground"
              onClick={onRetry}
            >
              <RotateCcw data-icon="inline-start" aria-hidden />
              分类加载失败，重试
            </Button>
          )}
        </div>

        {/* 与头部搜索入口同款：ghost + icon，标签退到 `aria-label` 与 tooltip。
            移动端的抽屉展开态不用旋转箭头表示 —— ghost variant 自带
            `aria-expanded:bg-muted`，按下去按钮自己变成实底，状态指示归设计系统
            而不是这里手写一个动效。桌面端这里是一次跳转，因此不带该属性。 */}
        {showPanelEntry && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="全部分类"
                  aria-expanded={panelExpanded}
                  className="shrink-0"
                  onPointerEnter={onPanelEntryIntent}
                  onPointerDown={onPanelEntryIntent}
                  onFocus={onPanelEntryIntent}
                  onClick={onPanelEntry}
                />
              }
            >
              <LayoutGrid />
            </TooltipTrigger>
            <TooltipContent>全部分类</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

type CategoryChipButtonProps = {
  label: string;
  active: boolean;
  /**
   * 聚合项（父分区的「全部X」或「推荐」）与深层子分类在条带上混排，但语义不同层级。
   * 深层项只能从展开面板选进来，若与聚合项画得一样，用户无法分辨自己点的是一整个
   * 父分区还是其中一个子分类 —— 尤其两者紧邻（深层项就插在其父项之后）。
   *
   * 区分方式刻意克制：非聚合项换成描边而不是实底，并在前面加一个小圆点表示
   * 「隶属于左侧父分区」。不改字号、不改高度，条带节奏保持一致。
   */
  aggregate: boolean;
  onClick: () => void;
};

function CategoryChipButton({ label, active, aggregate, onClick }: CategoryChipButtonProps) {
  return (
    <button
      type="button"
      data-motion-press
      data-category-chip-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[0.8rem] font-medium whitespace-nowrap transition-colors focus-ring",
        "[@media(pointer:coarse)]:h-8",
        active
          ? "bg-primary text-primary-foreground"
          : aggregate
            ? "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            : "border border-border-subtle text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {!aggregate && (
        <span
          aria-hidden
          className={cn(
            "size-1 shrink-0 rounded-full",
            active ? "bg-primary-foreground/70" : "bg-muted-foreground/50",
          )}
        />
      )}
      {label}
    </button>
  );
}
