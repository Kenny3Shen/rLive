import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid, RotateCcw } from "lucide-react";
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

/**
 * chip 的高度。
 *
 * 粗指针下取 44px（`h-11`），与设计系统给 button / tabs / toggle / select / input 的
 * `min-h-11` 一致。原先压到 32px 想把像素还给房间网格，但同一行里的「全部分类」按钮是
 * `size="icon"`，它继承那条 44px 下限且 `hasHiddenCategories` 对五个平台全部为真，
 * 于是 `items-center` 容器的高度本就由它决定 —— chip 压矮一个像素也省不到，只是让移动端
 * 最高频的点击目标成了全应用唯一低于 44px 的交互控件。
 */
const CHIP_HEIGHT = "h-7 [@media(pointer:coarse)]:h-11";

/**
 * 骨架 chip 的宽度序列。刻意错落：真实标签在中文平台约 50–76px、Twitch 的英文标签
 * 51–150px，等宽骨架会在数据落地那一帧让整条重新排布。
 */
const SKELETON_WIDTHS = ["w-14", "w-20", "w-16", "w-24", "w-16", "w-20"] as const;

/**
 * 一次箭头点击滚过的可见宽度比例。不取满屏：留一截重叠，跨越处那个被切成两半的
 * chip 才不会正好落在两次滚动之间被跳过。
 */
const ARROW_SCROLL_RATIO = 0.8;

/** 两端是否还能继续滚。驱动边缘渐隐与桌面箭头的出现。 */
type StripEdges = Readonly<{ start: boolean; end: boolean }>;

const NO_EDGES: StripEdges = { start: false, end: false };

/**
 * 把某个 chip 滚到条带中央。
 *
 * 刻意不用 `scrollIntoView`，也不让浏览器自己做聚焦滚动：两者都会沿祖先链向上滚动
 * 每一层可滚动祖先，而 Shell 的平台滑动 viewport 正是其中一层 —— 它虽然是
 * `overflow: hidden`，但 hidden 容器依然可被程序化滚动。模拟器实测：居中一个靠右的
 * chip 会把 viewport 带走 101px，相邻平台的面板从边上露出来、当前平台的房间网格被
 * 裁掉一条，看起来像轨道对齐坏了。
 *
 * 直接写自己的 `scrollLeft` 没有这个副作用，纵向位置也完全不受影响。用 rect 差值算
 * 目标位置而不用 `offsetLeft`，免得依赖 `offsetParent` 恰好是哪一层。
 */
function centerChip(strip: HTMLElement, chip: HTMLElement) {
  const stripBox = strip.getBoundingClientRect();
  const chipBox = chip.getBoundingClientRect();
  const delta = chipBox.left - stripBox.left - (stripBox.width - chipBox.width) / 2;
  strip.scrollTo({
    left: strip.scrollLeft + delta,
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

/**
 * 跟踪条带两端是否还有内容。
 *
 * 横滚是这条 bar 的主要浏览动作，而滚动条被显式隐藏（一条 8px 的水平滚动条会把
 * 高度再撑一截，而这东西整个浏览过程都钉在顶部）。没有替代提示时，Twitch 的 41 个
 * chip 在移动端只能看到约一成、桌面约四成，剩下的内容不可发现。
 *
 * 用 `scrollLeft` 与 `scrollWidth` 直接算而不监听 IntersectionObserver：条带内容随
 * 平台切换整体替换，观察者要跟着重建；这里只有两个布尔值，滚动与尺寸变化时重算一次
 * 即可。四舍五入留 1px 容差 —— 子像素布局下 `scrollLeft` 到不了精确的
 * `scrollWidth - clientWidth`。
 */
function useStripEdges(ref: React.RefObject<HTMLElement | null>, contentKey: string): StripEdges {
  const [edges, setEdges] = useState<StripEdges>(NO_EDGES);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;

    const measure = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      const left = strip.scrollLeft;
      setEdges((current) => {
        const next = { start: left > 1, end: left < max - 1 };
        return current.start === next.start && current.end === next.end ? current : next;
      });
    };

    measure();
    strip.addEventListener("scroll", measure, { passive: true });
    // 内容宽度还受字体加载、窗口缩放和条带自身高度变化影响，光靠 scroll 事件测不到。
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => {
      strip.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [contentKey, ref]);

  return edges;
}

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
  // 正是需要重新测量两端与重置首帧标记的时机。
  const contentKey = chips.map((chip) => chip.key).join("|");
  const edges = useStripEdges(stripRef, contentKey);

  // 选中项滑进视野。
  //
  // 平滑与瞬时的分界不是「首帧」而是「条带内容是否还是同一批」：同一批 chip 里换选中
  // 项，动画表达的是「你刚点的那项被带到中间」；而深链接首次落地、或换平台把整条内容
  // 替换掉时，平滑滚动会让条带在页面刚出现时自己从头滑到目标，读起来像布局没稳。
  const positionedForRef = useRef<string | null>(null);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>('[data-category-chip-active="true"]');
    const sameContent = positionedForRef.current === contentKey;
    positionedForRef.current = contentKey;
    if (!active) return;
    if (sameContent) {
      centerChip(strip, active);
      return;
    }
    const stripBox = strip.getBoundingClientRect();
    const activeBox = active.getBoundingClientRect();
    strip.scrollLeft += activeBox.left - stripBox.left - (stripBox.width - activeBox.width) / 2;
  }, [contentKey, selectedKey]);

  /**
   * tablist 的方向键导航。
   *
   * 手动激活（`aria-activedescendant` 之外的那条路）：方向键只移动焦点，Enter/Space
   * 才提交。分类条的每一次提交都要发一轮房间请求并换掉一条历史记录，跟着焦点自动选中
   * 会在用户按住方向键滑过 41 个 chip 时打出 41 次请求。
   *
   * 焦点用 `preventScroll` 移动，滚动由 `centerChip` 接管，理由同它的注释：浏览器的
   * 聚焦滚动会带走 Shell 的平台 viewport。
   */
  const focusChipAt = (index: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    const items = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    const target = items[Math.max(0, Math.min(index, items.length - 1))];
    if (!target) return;
    target.focus({ preventScroll: true });
    centerChip(strip, target);
  };

  const onStripKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (!strip) return;
    const items = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'));
    const current = items.findIndex((item) => item === document.activeElement);
    if (current < 0) return;

    switch (event.key) {
      case "ArrowRight":
        focusChipAt(current + 1);
        break;
      case "ArrowLeft":
        focusChipAt(current - 1);
        break;
      case "Home":
        focusChipAt(0);
        break;
      case "End":
        focusChipAt(items.length - 1);
        break;
      default:
        return;
    }
    // 只有实际处理掉的键才拦：方向键在此之外仍应滚动页面。
    event.preventDefault();
  };

  const scrollByPage = (direction: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollBy({
      left: direction * strip.clientWidth * ARROW_SCROLL_RATIO,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  /**
   * 组内唯一可 Tab 到的项（roving tabindex）。取选中项，选中项不在条带里时取第一项，
   * 于是无论条带内容如何变化，都恰好有一个 `tabindex="0"`。
   */
  const tabStopKey =
    chips.some((chip) => chip.key === selectedKey) || selectedKey === RECOMMEND_KEY
      ? selectedKey
      : RECOMMEND_KEY;

  // 边缘渐隐。遮罩画在滚动容器自身上，因此淡出的是视口两侧而不是内容的首尾两项。
  // 只在那一侧真的还有内容时才淡，否则静止的条带会无缘无故缺一角。
  //
  // 遮罩会连带淡化贴在边缘那个 chip 的焦点描边，但键盘路径到不了那里：方向键移动焦点
  // 时 `centerChip` 会把它带到中间，而 Tab 进来时落在的是已被居中的选中项。
  const fadeMask = `linear-gradient(to right, ${
    edges.start ? "transparent 0, #000 2rem" : "#000 0"
  }, ${edges.end ? "#000 calc(100% - 2rem), transparent 100%" : "#000 100%"})`;

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
        <div className="relative flex min-w-0 flex-1 items-center">
          <div
            ref={stripRef}
            role="tablist"
            aria-label="直播分区"
            aria-orientation="horizontal"
            onKeyDown={onStripKeyDown}
            // 纵向滚动仍归页面，横向留给这条 strip；同时声明成横滑手势的自有表面，
            // 使 Shell 的平台切换手势不会把这里的横向滚动抢走。
            data-horizontal-swipe-surface
            className="-mx-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1 py-0.5 touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}
          >
            <CategoryChipButton
              label="推荐"
              active={selectedKey === RECOMMEND_KEY}
              tabStop={tabStopKey === RECOMMEND_KEY}
              onClick={() => onSelect(null)}
            />

            {loading && !error && (
              <>
                {/* 宽度错落而非一律 `w-16`：真实 chip 在中文平台约 50–76px、Twitch
                    的英文标签 51–150px，等宽骨架会在数据落地那一帧整条重新排布。 */}
                {SKELETON_WIDTHS.map((width, index) => (
                  <Skeleton
                    key={index}
                    className={cn(CHIP_HEIGHT, "shrink-0 rounded-full", width)}
                  />
                ))}
              </>
            )}

            {!error &&
              chips.map((chip) => (
                <CategoryChipButton
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
                className="shrink-0 rounded-full text-muted-foreground"
                onClick={onRetry}
              >
                <RotateCcw data-icon="inline-start" aria-hidden />
                分类加载失败，重试
              </Button>
            )}
          </div>

          {/* 桌面横滚辅助。触摸端不出：那里滑动是直接手势，两个按钮只会占掉 chip 的
              宽度。它们落在渐隐带上、绝对定位不参与布局，因此出现与消失不会让 chip
              左右跳动。`aria-hidden` + 不可聚焦：键盘已有方向键与 Home/End，
              tablist 里多两个 tab stop 只是噪音。 */}
          <StripArrow side="start" visible={edges.start} onClick={() => scrollByPage(-1)} />
          <StripArrow side="end" visible={edges.end} onClick={() => scrollByPage(1)} />
        </div>

        {/* 与头部搜索入口同款：ghost + icon，标签退到 `aria-label` 与 tooltip。
            移动端的抽屉展开态不用旋转箭头表示 —— ghost variant 自带
            `aria-expanded:bg-muted`，按下去按钮自己变成实底，状态指示归设计系统
            而不是这里手写一个动效。桌面端这里是一次跳转，因此不带该属性。

            左侧一条分隔线：它是通往整棵分类树的唯一入口，紧贴横滚区最后一个 chip 时
            读起来像条带的第 42 项，而移动端右边缘正是横滑起手的位置。 */}
        {showPanelEntry && (
          <div className="flex shrink-0 items-center border-l border-border-subtle pl-1.5">
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

type StripArrowProps = {
  side: "start" | "end";
  visible: boolean;
  onClick: () => void;
};

/**
 * 桌面端的横滚箭头。
 *
 * 只在细指针下渲染（`[@media(pointer:fine)]`），且只在那一侧还有内容时可见。用
 * `opacity` 与 `pointer-events` 而不是条件渲染：淡入淡出跟着渐隐带一起变化，
 * 不会在到达两端的那一刻插入一次布局变动。
 */
function StripArrow({ side, visible, onClick }: StripArrowProps) {
  const Icon = side === "start" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-hidden
      tabIndex={-1}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 z-10 hidden size-7 -translate-y-1/2 items-center justify-center rounded-full",
        "border border-border-subtle bg-background text-muted-foreground shadow-sm",
        "transition-opacity duration-150 hover:text-foreground",
        "[@media(pointer:fine)]:flex",
        side === "start" ? "left-0" : "right-0",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

type CategoryChipButtonProps = {
  label: string;
  /**
   * 深层子分类所属的父分区名。只有从展开面板选进来的那一项有 —— 它插在自己父项之后，
   * 光看子分类名看不出隶属关系。
   */
  parentLabel?: string | undefined;
  active: boolean;
  /** 该项是否为组内那个可 Tab 到的落点（roving tabindex）。 */
  tabStop: boolean;
  onClick: () => void;
};

function CategoryChipButton({
  label,
  parentLabel,
  active,
  tabStop,
  onClick,
}: CategoryChipButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={tabStop ? 0 : -1}
      data-motion-press
      data-category-chip-active={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        CHIP_HEIGHT,
        "flex shrink-0 items-center gap-1 rounded-full px-3 text-[0.8rem] font-medium whitespace-nowrap transition-colors focus-ring",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
    >
      {parentLabel && (
        <>
          <span className={cn(active ? "text-primary-foreground/75" : "text-muted-foreground/70")}>
            {parentLabel}
          </span>
          <span aria-hidden className={cn(active ? "text-primary-foreground/45" : "text-muted-foreground/45")}>
            /
          </span>
        </>
      )}
      {label}
    </button>
  );
}
