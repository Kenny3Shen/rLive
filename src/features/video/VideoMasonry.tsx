import { Children, memo, useCallback, useLayoutEffect, useRef, type ReactNode } from "react";

const ROW_HEIGHT = 4;
const GRID_CLASS =
  "grid grid-cols-2 items-start gap-x-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 [@media(min-width:80rem)_and_(pointer:coarse)]:grid-cols-5!";

export function videoMasonryRowSpan(height: number): number {
  return Number.isFinite(height) && height > 0 ? Math.max(1, Math.ceil(height / ROW_HEIGHT)) : 1;
}

function applyMeasurements(measurements: readonly [HTMLElement, number][]) {
  for (const [element, height] of measurements) {
    const span = `span ${videoMasonryRowSpan(height)}`;
    if (element.style.gridRowEnd !== span) element.style.gridRowEnd = span;
  }
}

/** 自然高度瀑布流，仍是全量 DOM；稳定观察器只接管新增节点，不在分页时重测旧卡。 */
export const VideoMasonry = memo(function VideoMasonry({
  children,
  "aria-hidden": ariaHidden,
}: {
  children: ReactNode;
  "aria-hidden"?: boolean;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const elementsRef = useRef(new Set<HTMLElement>());
  const pendingRef = useRef(new Set<HTMLElement>());
  const bindItem = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    elementsRef.current.add(element);
    pendingRef.current.add(element);
    observerRef.current?.observe(element, { box: "border-box" });
    // React 19 的 ref 清理，节点删除时只解除自身观察。
    return () => {
      elementsRef.current.delete(element);
      pendingRef.current.delete(element);
      observerRef.current?.unobserve(element);
    };
  }, []);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      applyMeasurements(
        entries.map((entry) => [
          entry.target as HTMLElement,
          entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height,
        ]),
      );
    });
    observerRef.current = observer;
    for (const element of elementsRef.current) observer.observe(element, { box: "border-box" });
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (!gridRef.current || !observerRef.current) return;
    // 一次提交的新增节点批量读完再写；尺寸/字体后续变化由持久 RO 跟踪。
    applyMeasurements(
      [...pendingRef.current].map((element) => [element, element.getBoundingClientRect().height]),
    );
    pendingRef.current.clear();
    gridRef.current.style.gridAutoRows = `${ROW_HEIGHT}px`;
  });

  return (
    <div ref={gridRef} data-slot="video-masonry" className={GRID_CLASS} aria-hidden={ariaHidden}>
      {Children.toArray(children).map((child, index) => (
        <div
          key={typeof child === "object" && "key" in child ? child.key : index}
          ref={bindItem}
          data-slot="video-masonry-item"
          className="min-w-0 pb-4"
        >
          {child}
        </div>
      ))}
    </div>
  );
});
