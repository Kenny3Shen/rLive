import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { findVerticalScrollParent } from "@/shared/gestures/pullToRefresh";
import { flattenHistoryTimeline, type HistoryDateGroup } from "./historyGrouping";

/**
 * 元素在滚动容器内容坐标系中的纵向偏移。
 *
 * 用 offsetTop 累加而不是两个 `getBoundingClientRect` 相减：历史页外面套着页面平移
 * 与横滑 track，两者都在祖先上留着 transform，rect 会把这些位移算进去，而 `scrollTop`
 * 不会——混用两套坐标系会让窗口整体错位。offsetTop 是布局量，对 transform 免疫。
 */
function offsetWithinScroller(node: HTMLElement, scroller: HTMLElement): number {
  let offset = 0;
  let current: HTMLElement | null = node;
  while (current && current !== scroller) {
    offset += current.offsetTop;
    const parent: Element | null = current.offsetParent;
    // 定位祖先链绕过了滚动容器（理论上不会：`app-page` 是 relative），
    // 退回 rect 差值，至少不会把窗口锚到 0。
    if (!(parent instanceof HTMLElement)) {
      return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top +
        scroller.scrollTop;
    }
    current = parent;
  }
  return offset;
}

/** 与条目形态无关：只用 `itemKey`/`renderItem`，因此视频历史（无 `site_id`）也能复用。 */
type HistoryTimelineProps<T> = {
  groups: HistoryDateGroup<T>[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** 单条记录卡的估高（px）。测量前用它排布，首屏滚动条长度靠它接近真实值。 */
  estimateItemSize: number;
  /**
   * 本时间线是否为当前页签。
   *
   * 三条时间线常挂载在同一条横滑 track 上、共享 Shell 的滚动容器，撑开滚动高度的
   * 只能是当前这条：否则最长的一条（观看历史满额 2000 行）会把滚动范围留给另外两条，
   * 切过去后能滚到大片空白。非活动面板仍按共享的 scrollTop 出行，横滑途中邻居
   * 显示的是同一滚动位置上的内容。
   */
  active: boolean;
};

/**
 * 按日分组的历史时间线，窗口化渲染。
 *
 * 滚动容器是 Shell 的 `app-page` 而不是自己：历史页整页滚动（含筛选行与下拉刷新），
 * 列表另开一个滚动视口会出现双滚动条。因此这里要向虚拟列表交代两件事——外部滚动
 * 元素，以及列表在该元素内容里的起始偏移（`scrollMargin`）。
 *
 * 行距不用 flex `gap`：行绝对定位，间距必须计入被测高度，否则测量值比实际占位小，
 * 累积成越滚越偏。改由每行自带上内边距，首行不留。
 */
export function HistoryTimeline<T>({
  groups,
  itemKey,
  renderItem,
  estimateItemSize,
  active,
}: HistoryTimelineProps<T>) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const bindList = useCallback((node: HTMLDivElement | null) => {
    setListNode(node);
    setScroller(node ? findVerticalScrollParent(node) : null);
  }, []);

  const syncScrollMargin = useCallback(() => {
    if (!listNode || !scroller) return;
    const next = offsetWithinScroller(listNode, scroller);
    setScrollMargin((current) => (current === next ? current : next));
  }, [listNode, scroller]);

  // 无依赖：筛选行会随视图增减控件、随宽度换行，列表起点因此在任意一次提交后都可能
  // 移动。测量只读几个 offsetTop，值没变就不置 state，不会自激。
  useLayoutEffect(syncScrollMargin);

  useLayoutEffect(() => {
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncScrollMargin);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller, syncScrollMargin]);

  const rows = useMemo(() => flattenHistoryTimeline(groups, itemKey), [groups, itemKey]);

  // 规则针对 React Compiler 的记忆化；本项目未启用编译器（`vite.config.ts` 的
  // `react()` 无 `reactCompiler`，`babel-plugin-react-compiler` 也未安装），
  // 且虚拟列表返回值只在本组件内消费，不传给被记忆化的下游。
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    scrollMargin,
    // 记录卡按传入估高；标题行是一行小字加分隔线。两者都会在进入视口时被实测校正。
    estimateSize: (index) => (rows[index]?.kind === "heading" ? 44 : estimateItemSize),
    // 键取自记录身份而不是下标：删一条或换筛选后，仍在表内的行保留已测高度。
    getItemKey: (index) => rows[index]?.key ?? index,
    // 触摸滚动一甩就是几屏，默认 1 行缓冲会露白。
    overscan: 6,
  });

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div
      ref={bindList}
      data-slot="history-timeline"
      className="relative w-full"
      style={{ height: active ? virtualizer.getTotalSize() : 0 }}
    >
      {virtualRows.map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        const previous = rows[virtualRow.index - 1];
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 top-0"
            style={{
              transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {row.kind === "heading" ? (
              <h2
                className={`flex items-center gap-2 pb-2 text-xs font-medium text-muted-foreground ${
                  previous ? "pt-4" : ""
                }`}
              >
                <span>{row.label}</span>
                <span className="h-px flex-1 bg-border-subtle" />
              </h2>
            ) : (
              <div className={previous?.kind === "heading" ? "" : "pt-2.5"}>
                {renderItem(row.item)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
