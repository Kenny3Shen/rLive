import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import { cn } from "@/lib/utils";

/**
 * 横滚 chip 条带的共用尺寸、滚动与键盘逻辑。
 *
 * 从首页的直播分区条（`features/category/CategoryBar.tsx`）原样抽出，供它和视频页
 * 的分区条共用。抽取是纯搬移：常量字面量、`centerChip` 的 rect 差值算法、
 * `useStripEdges` 的三布尔测量与 `StripArrow` 的显隐规则都未改动，因此直播分区条
 * 的行为与视觉不变。两条 bar 的差异只在 chip 的数据来源与 `aria-label`，
 * 那些留在各自的组件里。
 */

/**
 * chip 的可见高度。
 *
 * 粗指针下 36px，不是 44px：strip 被 `h-12` 锁在 48px，44px 的 chip 只剩 `py-0.5`
 * 那 2px 缝，实心背景几乎顶满整条 bar，读起来像 bar 自己换了底色而不是里面放着一排
 * 按钮。36px 留出上下各 6px，chip 重新成为浮在 bar 上的东西 —— bar 高度不变，
 * 让出来的是 chip 自己的像素。
 *
 * 44px 的触摸下限没有放弃，它挪到了 `CHIP_TOUCH_TARGET` 的透明外扩里。
 *
 * 附带的 `min-h-0` 是给条带里那些基于 `Button` 的成员用的（错误态的重试按钮）：
 * button variant 自带 `[@media(pointer:coarse)]:min-h-11`，而 `min-height` 压得住
 * `height`，不撤掉它那颗按钮会独自长到 44px 顶满内容盒。它靠 tailwind-merge 起作用 ——
 * 同组同修饰符只留最后一个，`min-h-11` 因此直接从 class 列表里消失，不依赖两条规则
 * 在生成的 CSS 里谁先谁后。这与 `styles.css` 里设置页的做法同源：视觉高度归控件，
 * 触摸高度归 `::after`。
 *
 * 水平方向取 `px-2.5`：对 12.8px 的标签足够，且与设计系统里 input / select 的同名
 * 档位一致。B 站 13 个分区因此从 814px 收到 762px。
 */
export const CHIP_HEIGHT = "h-7 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:min-h-0";

/**
 * 粗指针下把命中区补回 44px。
 *
 * 一层透明的 `::after` 纵向外扩 4px：视觉框、背景与焦点描边仍是 36px，手指能碰到的
 * 范围与 `h-11` 时相同，于是 chip 不会成为全应用唯一低于设计系统 `min-h-11` 的
 * 交互控件。4px 正好填满 strip 的内容盒（`h-12` 48px 减 `py-0.5` 两侧共 4px 得
 * 44px，36px 的 chip 居中后上下各余 4px），命中区不越过 padding 边缘，
 * 因此不会触发纵向溢出。
 */
export const CHIP_TOUCH_TARGET =
  "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:-inset-y-1 [@media(pointer:coarse)]:after:content-['']";

/**
 * chip 的圆角。
 *
 * 不用 `rounded-full`：胶囊形在粗指针下尤其不划算 —— 全圆角两端各吃掉半个高度只
 * 用于弧线，而同一行里的「全部分类」按钮是圆角矩形，两种形状并排读起来像两套控件。
 *
 * 取设计系统 `size="sm"` 那一档的半径（实测 9.6px）。chip 的其余尺寸（`px-2.5`、
 * `text-[0.8rem]`，细指针下连 `h-7` 都对得上）本来就是那一档，`toggle` 里同款尺寸的
 * 按钮用的也正是这个值，形状没有理由自己另开一路。隔壁「全部分类」是 `rounded-lg`
 * 的 12px：设计系统里半径随控件档位走，图标按钮那一档本就比 `sm` 大一点，两者
 * 因此不是同一个数 —— 要对齐的是「都是圆角矩形」，不是精确到小数点的同一半径。
 */
export const CHIP_RADIUS = "rounded-[min(var(--radius-md),12px)]";

/**
 * 骨架 chip 的宽度序列。刻意错落：真实标签在中文平台约 45–71px、Twitch 的英文标签
 * 46–145px，等宽骨架会在数据落地那一帧让整条重新排布。
 */
export const CHIP_SKELETON_WIDTHS = ["w-12", "w-18", "w-14", "w-22", "w-14", "w-18"] as const;

/**
 * 一次箭头点击滚过的可见宽度比例。不取满屏：留一截重叠，跨越处那个被切成两半的
 * chip 才不会正好落在两次滚动之间被跳过。
 */
const ARROW_SCROLL_RATIO = 0.8;

/** 选中 chip 的标记属性，`centerChip` 与两条 bar 的定位副作用都按它查询。 */
export const CHIP_ACTIVE_ATTRIBUTE = "data-chip-active";

/**
 * 条带的滚动余量。
 *
 * `overflowing` 决定桌面箭头是否登场，`start` / `end` 决定各自那一侧是否还能按。
 * 三者分开而不是只留两端：箭头占布局宽度，只按「这一侧还有内容」显隐会让 chip 在
 * 滚到两端的那一刻左右跳动；按「整条是否溢出」显隐，则滚动过程中宽度恒定，
 * 只在换平台或缩窗口改变溢出状态时变一次。
 */
export type StripEdges = Readonly<{ overflowing: boolean; start: boolean; end: boolean }>;

const NO_EDGES: StripEdges = { overflowing: false, start: false, end: false };

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
export function centerChip(strip: HTMLElement, chip: HTMLElement) {
  // 条带没溢出时没有横向滚动可做，`scrollLeft` 恒为 0。
  if (strip.scrollWidth <= strip.clientWidth) return;
  const stripBox = strip.getBoundingClientRect();
  const chipBox = chip.getBoundingClientRect();
  const delta = chipBox.left - stripBox.left - (stripBox.width - chipBox.width) / 2;
  strip.scrollTo({
    left: strip.scrollLeft + delta,
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

/**
 * 跟踪条带的滚动余量。
 *
 * 横滚是这条 bar 的主要浏览动作，而滚动条被显式隐藏（经典滚动条会把这条常驻顶部的
 * bar 再撑一截）。移动端还有横滑手势兜着，桌面只剩滚轮 —— 没有替代提示时 Twitch 的
 * 41 个 chip 在桌面只能看到约四成，剩下的内容不可发现，箭头就是那个替代提示。
 *
 * 用 `scrollLeft` 与 `scrollWidth` 直接算而不监听 IntersectionObserver：条带内容随
 * 平台切换整体替换，观察者要跟着重建；这里只有三个布尔值，滚动与尺寸变化时重算一次
 * 即可。四舍五入留 1px 容差 —— 子像素布局下 `scrollLeft` 到不了精确的
 * `scrollWidth - clientWidth`。
 *
 * 箭头登场会让条带变窄，`ResizeObserver` 于是再测一轮 —— 但更窄只会让溢出更多，
 * `overflowing` 不会翻回 false，因此没有「出现 → 不溢出 → 消失」的抖动。
 */
export function useStripEdges(
  ref: React.RefObject<HTMLElement | null>,
  contentKey: string,
): StripEdges {
  const [edges, setEdges] = useState<StripEdges>(NO_EDGES);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;

    const measure = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      const left = strip.scrollLeft;
      setEdges((current) => {
        const next = { overflowing: max > 1, start: left > 1, end: left < max - 1 };
        return current.overflowing === next.overflowing &&
          current.start === next.start &&
          current.end === next.end
          ? current
          : next;
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

/** 一次箭头点击的横滚量，供两条 bar 的箭头回调共用。 */
export function scrollStripByPage(strip: HTMLElement | null, direction: -1 | 1) {
  if (!strip) return;
  strip.scrollBy({
    left: direction * strip.clientWidth * ARROW_SCROLL_RATIO,
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

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
export function handleStripArrowKeys(
  strip: HTMLElement | null,
  event: React.KeyboardEvent<HTMLElement>,
): void {
  if (!strip) return;
  const items = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'));
  const current = items.findIndex((item) => item === document.activeElement);
  if (current < 0) return;

  const focusChipAt = (index: number) => {
    const target = items[Math.max(0, Math.min(index, items.length - 1))];
    if (!target) return;
    target.focus({ preventScroll: true });
    centerChip(strip, target);
  };

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
}

/**
 * 把选中 chip 滑进视野的定位副作用。
 *
 * 平滑与瞬时的分界不是「首帧」而是「条带内容是否还是同一批」：同一批 chip 里换选中
 * 项，动画表达的是「你刚点的那项被带到中间」；而深链接首次落地、或换平台把整条内容
 * 替换掉时，平滑滚动会让条带在页面刚出现时自己从头滑到目标，读起来像布局没稳。
 */
export function useCenterActiveChip(
  stripRef: React.RefObject<HTMLElement | null>,
  contentKey: string,
  selectedKey: string,
): void {
  const positionedForRef = useRef<string | null>(null);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>(`[${CHIP_ACTIVE_ATTRIBUTE}="true"]`);
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
  }, [contentKey, selectedKey, stripRef]);
}

export type StripArrowProps = {
  side: "start" | "end";
  /** 整条是否溢出。为假时不渲染，桌面窗口够宽的常态下这两个按钮不存在。 */
  mounted: boolean;
  /** 这一侧是否还有内容可滚。为假时禁用而不卸载，避免按到端点时布局跳动。 */
  enabled: boolean;
  onClick: () => void;
};

/**
 * 桌面端的横滚箭头。
 *
 * 只在细指针下渲染（`[@media(pointer:fine)]:flex` 配 `hidden`）：触摸端滑动是直接
 * 手势，两个按钮只会占掉 chip 的宽度。
 *
 * `aria-hidden` + 不可聚焦：键盘已有方向键与 Home/End 走遍整条，tablist 的可达性
 * 不依赖这两个按钮，把它们塞进 Tab 序列只是给键盘用户多两个空站。这也意味着它们
 * 纯属指针辅助 —— 读屏用户看到的仍是一条完整的 tablist。
 *
 * 尺寸对齐右侧的「全部分类」：`size="icon"` 在粗指针下有 44px 下限，但这两个按钮
 * 只在细指针下出现，那里两者都是 32px。
 */
export function StripArrow({ side, mounted, enabled, onClick }: StripArrowProps) {
  if (!mounted) return null;
  const Icon = side === "start" ? ChevronLeft : ChevronRight;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-hidden
      tabIndex={-1}
      disabled={!enabled}
      onClick={onClick}
      // `disabled:opacity-50` 来自 button variant；`shrink-0` 免得箭头被 chip 挤扁。
      className="hidden shrink-0 text-muted-foreground [@media(pointer:fine)]:flex"
    >
      <Icon aria-hidden />
    </Button>
  );
}

export type ChipButtonProps = {
  label: string;
  /**
   * 次级前缀。直播分区条用它标注深层子分类所属的父分区名 —— 那一项插在自己父项
   * 之后，光看子分类名看不出隶属关系。
   */
  parentLabel?: string | undefined;
  active: boolean;
  /** 该项是否为组内那个可 Tab 到的落点（roving tabindex）。 */
  tabStop: boolean;
  onClick: () => void;
};

export function ChipButton({ label, parentLabel, active, tabStop, onClick }: ChipButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={tabStop ? 0 : -1}
      data-motion-press
      data-chip-active={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        CHIP_HEIGHT,
        CHIP_RADIUS,
        CHIP_TOUCH_TARGET,
        "relative flex shrink-0 items-center gap-1 px-2.5 text-[0.8rem] font-medium whitespace-nowrap transition-colors focus-ring",
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
          <span
            aria-hidden
            className={cn(active ? "text-primary-foreground/45" : "text-muted-foreground/45")}
          >
            /
          </span>
        </>
      )}
      {label}
    </button>
  );
}

/**
 * 条带本体的公共 class。
 *
 * `h-12` 锁死高度：`py-0.5` 两侧各 2px 加 44px 内容盒，正好等于头部平台 bar 的
 * 48px。36px 的 chip 居中后，焦点描边（1.9px 描边 + 2px offset）落在 99–143px，
 * 刚好贴着内容盒的上下沿而不越界，`py-0.5` 那 2px 是留给描边的最后一道余量。
 * 移动端滚动条是覆盖式的（实测占 0px）不影响布局，桌面经典滚动条会另吃十几像素
 * 并把 chip 压扁，所以两条隐藏规则都留着 —— 高度由 `h-12` 声明，不再靠
 * 「滚动条恰好不占位」这件事撑着。
 *
 * 隐藏规则生效的前提：styles.css 里全局 `* { scrollbar-width: thin }` 住在
 * `@layer base`。它若留在层外，会压过 `@layer utilities` 里的这两条（未分层样式在
 * 级联中赢过一切 layer），且 Chromium 一旦 `scrollbar-width` 非 `auto` 就会连带
 * 忽略 `::-webkit-scrollbar` 自定义，两条路同时堵死。
 */
export const CHIP_STRIP_CLASS =
  "-mx-1 flex h-12 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1 py-0.5 touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
 * 整条 bar 的外层 class（sticky 定位 + 贴容器边缘的负外边距）。
 *
 * sticky 的坑：Shell 的滚动容器带 `p-4 md:p-5`，`top-0` 会把条带钉在内边距
 * *下方*，房间封面从上面那条缝里穿过去。用负外边距把条带撑到容器边缘、再用同量
 * 内边距把内容推回原位，并把 `top` 设成负的内边距值，使黏停位置落在容器真正的
 * 上沿。两者必须配对：只给负外边距，条带会停在缝下面。
 *
 * 实心背景，不用半透明+模糊：房间封面在下面滚过时会糊成一片彩色噪点，文字对比度
 * 随内容变化而不可控。
 */
export const CHIP_BAR_CLASS = cn(
  "sticky z-20 -mx-4 -mt-4 px-4 md:-mx-5 md:-mt-5 md:px-5",
  "top-[-1rem] md:top-[-1.25rem]",
  "border-b border-border-subtle bg-background",
);
