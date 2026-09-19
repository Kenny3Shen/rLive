import { Children, memo, useLayoutEffect, useRef, type ReactNode } from "react";

/** 小行高模拟瀑布流，最多产生不足 4px 的向上取整留白。 */
const ROW_HEIGHT = 4;
const GRID_CLASS =
  "grid grid-cols-2 items-start gap-x-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 [@media(min-width:80rem)_and_(pointer:coarse)]:grid-cols-5!";

export function videoMasonryRowSpan(height: number): number {
  return Number.isFinite(height) && height > 0 ? Math.max(1, Math.ceil(height / ROW_HEIGHT)) : 1;
}

/**
 * VOD 瀑布流：保留 DOM 顺序与卡片身份，只按自然高度分配 grid 行跨度。
 * 不使用 CSS columns（追加会重新平衡旧条目）或 dense（回填会改变视觉阅读顺序）。
 * 一个 ResizeObserver 跟踪所有条目；封面尺寸、字体或列宽变化后重新测量。
 * 无 ResizeObserver 时保留普通网格，不让卡片重叠。
 */
export const VideoMasonry = memo(function VideoMasonry({
  children,
  "aria-hidden": ariaHidden,
}: {
  children: ReactNode;
  "aria-hidden"?: boolean;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const items = Children.toArray(children);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const elements = Array.from(grid.children) as HTMLElement[];
    const apply = (measurements: readonly [HTMLElement, number][]) => {
      for (const [element, height] of measurements) {
        const span = `span ${videoMasonryRowSpan(height)}`;
        if (element.style.gridRowEnd !== span) element.style.gridRowEnd = span;
      }
    };
    // 批量读完再写，避免每张卡反复触发同步布局。首屏与追加均在绘制前完成，
    // 外部的分页哨兵始终落在最高一列之后。
    apply(elements.map((element) => [element, element.getBoundingClientRect().height]));
    grid.style.gridAutoRows = `${ROW_HEIGHT}px`;
    const observer = new ResizeObserver((entries) => {
      apply(
        entries.map((entry) => [
          entry.target as HTMLElement,
          entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height,
        ]),
      );
    });
    for (const element of elements) observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [children]);

  return (
    <div ref={gridRef} data-slot="video-masonry" className={GRID_CLASS} aria-hidden={ariaHidden}>
      {items.map((child, index) => (
        // 间距计入测量高度，避免 CSS row-gap 在细网格里被逐行重复累计。
        // Children.toArray 已归一化显式 key；不要以分列位置作为卡片身份。
        <div
          key={typeof child === "object" && "key" in child ? child.key : index}
          data-slot="video-masonry-item"
          className="min-w-0 pb-4"
        >
          {child}
        </div>
      ))}
    </div>
  );
});
