import { useRef } from "react";
import { LayoutGrid, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CHIP_BAR_CLASS,
  CHIP_HEIGHT,
  CHIP_RADIUS,
  CHIP_SKELETON_WIDTHS,
  CHIP_STRIP_CLASS,
  CHIP_TOUCH_TARGET,
  ChipButton,
  StripArrow,
  handleStripArrowKeys,
  scrollStripByPage,
  useCenterActiveChip,
  useStripEdges,
} from "@/shared/components/ChipStrip";
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
 * 整条按 tablist 语义实现：这一组按钮的作用正是「选一个，替换下方内容」。它带来的
 * 不只是正确的角色 —— roving tabindex 让整组塌成一个 tab stop，键盘用户不必按 41 次
 * Tab 才能越过 Twitch 的分类条，方向键与 Home/End 则同时解决了横滚的可发现性。
 * 不用 `aria-current="page"`：变的只是 `?cat=` 查询参数，不是页面。
 *
 * 分类树失败时降级成只有「推荐」加一个重试按钮。分区是发现表面的加分项，
 * 推荐流才是首页的主体，不能让一次分类请求失败把整页拖下水。
 *
 * 尺寸常量、横滚箭头、roving tabindex 与居中滚动都住在
 * `shared/components/ChipStrip.tsx`，与视频页的分区条共用同一套实现。
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
  // chip 集合的身份。换平台、分类树到达、插入深层选中项都会改变它，
  // 正是需要重置首帧标记的时机。
  const contentKey = chips.map((chip) => chip.key).join("|");
  const edges = useStripEdges(stripRef, contentKey);
  useCenterActiveChip(stripRef, contentKey, selectedKey);

  /**
   * 组内唯一可 Tab 到的项（roving tabindex）。取选中项，选中项不在条带里时取第一项，
   * 于是无论条带内容如何变化，都恰好有一个 `tabindex="0"`。
   */
  const tabStopKey =
    chips.some((chip) => chip.key === selectedKey) || selectedKey === RECOMMEND_KEY
      ? selectedKey
      : RECOMMEND_KEY;

  return (
    <div className={CHIP_BAR_CLASS}>
      {/* 整条 bar 的高度就是条带的 `h-12`，这一行不再另加竖直内边距：桌面与
          移动端同高，箭头与「全部分类」靠 `items-center` 与 chip 共用同一条
          竖直中线。 */}
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {/* 桌面横滚辅助。移动端不出：那里滑动是直接手势，两个按钮只会占掉 chip 的
              宽度。它们是 strip 的 flex 兄弟而非绝对定位的浮层 —— 边缘渐隐已经撤掉，
              浮在 chip 上的实底按钮会盖掉半个分区名，也让「按下去是翻页还是选分区」
              变得可疑。占布局的代价是溢出出现时 chip 区窄掉两颗按钮的宽度，
              但按 `overflowing` 显隐（而不是按各自那侧还有没有内容），滚动过程中
              宽度恒定，只在换平台或缩窗口时变一次。 */}
          <StripArrow
            side="start"
            mounted={edges.overflowing}
            enabled={edges.start}
            onClick={() => scrollStripByPage(stripRef.current, -1)}
          />
          <div
            ref={stripRef}
            role="tablist"
            aria-label="直播分区"
            aria-orientation="horizontal"
            onKeyDown={(event) => handleStripArrowKeys(stripRef.current, event)}
            // 纵向滚动仍归页面，横向留给这条 strip；同时声明成横滑手势的自有表面，
            // 使 Shell 的平台切换手势不会把这里的横向滚动抢走。
            data-horizontal-swipe-surface
            className={CHIP_STRIP_CLASS}
          >
            <ChipButton
              label="推荐"
              active={selectedKey === RECOMMEND_KEY}
              tabStop={tabStopKey === RECOMMEND_KEY}
              onClick={() => onSelect(null)}
            />

            {loading && !error && (
              <>
                {CHIP_SKELETON_WIDTHS.map((width, index) => (
                  <Skeleton
                    key={index}
                    className={cn(CHIP_HEIGHT, CHIP_RADIUS, "shrink-0", width)}
                  />
                ))}
              </>
            )}

            {!error &&
              chips.map((chip) => (
                <ChipButton
                  key={chip.key}
                  label={chip.label}
                  parentLabel={chip.parentLabel}
                  active={chip.key === selectedKey}
                  tabStop={tabStopKey === chip.key}
                  onClick={() => onSelect(chip.category)}
                />
              ))}

            {error && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                // 借 chip 的三件套让它与相邻 chip 同高同形 —— 它在错误态里顶的正是
                // chip 的位置。`border-0` 撤掉 button variant 那圈透明边框：`::after`
                // 以 padding 盒定位，1px 边框会把命中区从 44px 削到 42.5px。
                className={cn(
                  CHIP_HEIGHT,
                  CHIP_RADIUS,
                  CHIP_TOUCH_TARGET,
                  "relative shrink-0 border-0 text-muted-foreground",
                )}
                onClick={onRetry}
              >
                <RotateCcw data-icon="inline-start" aria-hidden />
                分类加载失败，重试
              </Button>
            )}
          </div>
          <StripArrow
            side="end"
            mounted={edges.overflowing}
            enabled={edges.end}
            onClick={() => scrollStripByPage(stripRef.current, 1)}
          />
        </div>

        {/* 与头部搜索入口同款：ghost + icon，标签退到 `aria-label` 与 tooltip。
            移动端的抽屉展开态不用旋转箭头表示 —— ghost variant 自带
            `aria-expanded:bg-muted`，按下去按钮自己变成实底，状态指示归设计系统
            而不是这里手写一个动效。桌面端这里是一次跳转，因此不带该属性。

            左侧一条分隔线：它是通往整棵分类树的唯一入口，紧贴横滚区最后一个 chip 时
            读起来像条带的第 42 项，而移动端右边缘正是横滑起手的位置。

            粗指针下 `-mr-3.5` 配收紧的 `pl-0.5` 是一组光学对齐：44px 按钮盒里
            16px 图标两侧各藏 14px 空白，负右外边距把盒子拉进条带的右侧内边距
            （溢出可见，命中区到屏幕边缘仅剩 2px），图标右缘于是落在内容右缘上，
            与下方房间卡片的右缘齐平，也与头部搜索入口的图标共线；分隔线随盒
            子右移并收紧到图标左侧的 16px 可见留白恰好等于图标右侧到屏幕边缘
            的留白，按钮两侧的空白因此一致。细指针下按钮只有 32px 宽，这组
            偏移不成立，桌面端维持原位。

            这个按钮与头部搜索入口上下相邻且同尺寸，两者的竖直中线要对齐：本条带的
            横向内边距靠 `-mx-4 px-4 md:-mx-5 md:px-5` 跟住内容容器，头部也用同一档，
            且两处的光学偏移共用 `-mr-3.5` 一档；改动任一侧都会让这对按钮错开。 */}
        {showPanelEntry && (
          <div className="flex shrink-0 items-center border-l border-border-subtle pl-1.5 [@media(pointer:coarse)]:pl-0.5 [@media(pointer:coarse)]:-mr-3.5">
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
          </div>
        )}
      </div>
    </div>
  );
}
