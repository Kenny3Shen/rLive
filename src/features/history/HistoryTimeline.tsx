import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { flattenHistoryTimeline, type HistoryDateGroup } from "./historyGrouping";
import {
  HISTORY_TIMELINE_OVERSCAN,
  historyAnchorTo,
  observeHistoryOffset,
  observeHistoryRect,
  offsetWithinScrollElement,
  readHistoryScrollSnapshot,
  registerHistoryRefreshScrollReset,
  resolveHistoryScrollElement,
  saveHistoryScrollSnapshot,
} from "./historyVirtual";

/**
 * 观察器与滚动函数在模块作用域定义。
 *
 * 虚拟列表把选项对象放进 `setOptions` 的依赖里，每次渲染换一个新的观察器身份会
 * 让订阅反复重绑；这些函数无闭包状态，固定一份即可。
 */
const virtualizerObservers = {
  observeElementRect: observeHistoryRect,
  observeElementOffset: observeHistoryOffset,
};

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
  /**
   * 本视图在滚动快照记忆里的键。
   *
   * 三个视图共用同一个滚动容器，但内容是彼此独立的列表；键不同，各自恢复各自的
   * 位置，切视图才不会把观看历史的偏移套到弹幕历史上。
   */
  snapshotKey: string;
  /**
   * 刷新回顶的注册令牌。
   *
   * 历史页在刷新前推进它，本时间线因此把滚动位置归零 —— 见下方
   * `scrollToTopOnRefresh`：锚定会把新记录留在视口上方，而刷新的意图正是看最新。
   * 传 `0` 表示不参与。
   */
  refreshResetToken?: number;
};

/**
 * 按日分组的历史时间线，窗口化渲染。
 *
 * 滚动容器是 Shell 的 `app-page` 而不是自己：历史页整页滚动（含筛选行与下拉刷新），
 * 列表另开一个滚动视口会出现双滚动条。因此这里要向虚拟列表交代两件事——外部滚动
 * 元素，以及列表在该元素内容里的起始偏移（`scrollMargin`）。没有可滚动祖先时退回
 * 文档滚动元素，同一条代码路径因此同时覆盖元素滚动与窗口滚动。
 *
 * 行距不用 flex `gap`：行绝对定位，间距必须计入被测高度，否则测量值比实际占位小，
 * 累积成越滚越偏。改由每行自带上内边距，首行不留。
 *
 * 动态内容由 `measureElement` 实测；时间倒序列表的新记录从顶部插入，靠稳定行键 +
 * `anchorTo` 把可见行钉在原位；离开或切视图前用 `takeSnapshot()` 拍下实测高度与
 * 偏移，重挂载时作为 `initialMeasurementsCache` / `initialOffset` 恢复。
 */
export function HistoryTimeline<T>({
  groups,
  itemKey,
  renderItem,
  estimateItemSize,
  active,
  snapshotKey,
  refreshResetToken = 0,
}: HistoryTimelineProps<T>) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [anchorTo, setAnchorTo] = useState<"start" | "end">("start");

  // 快照只在首次挂载读取一次：实测高度喂回虚拟列表，恢复因此不必先按估高铺一遍
  // 再校正。运行期的滚动位置由 `offsetRef` 持续跟踪。
  const [snapshot] = useState(() => readHistoryScrollSnapshot(snapshotKey));
  const offsetRef = useRef(snapshot?.offset ?? 0);

  const bindList = useCallback((node: HTMLDivElement | null) => {
    setListNode(node);
    setScroller(node ? resolveHistoryScrollElement(node) : null);
  }, []);

  const syncScrollMargin = useCallback(() => {
    if (!listNode || !scroller) return;
    const next = offsetWithinScrollElement(listNode, scroller);
    setScrollMargin((current) => (current === next ? current : next));
  }, [listNode, scroller]);

  // 无依赖：筛选行会随视图增减控件、随宽度换行，列表起点因此在任意一次提交后都可能
  // 移动。测量只读几个 offsetTop，值没变就不置 state，不会自激。
  useLayoutEffect(syncScrollMargin);

  useLayoutEffect(() => {
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncScrollMargin);
    // 文档滚动元素由 `observeHistoryRect` 的窗口 resize 负责。
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller, syncScrollMargin]);

  const rows = useMemo(() => flattenHistoryTimeline(groups, itemKey), [groups, itemKey]);
  // 虚拟列表把这两个函数放进测量记忆的依赖里，每次渲染换一个新闭包会让整表重算；
  // 依赖又必须是「最新行集」。因此函数身份依赖 ref（永不变化），行集从 ref 里读——
  // 渲染期同步，读取方拿到的永远是本次提交的行集。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const estimateSizeRef = useRef(estimateItemSize);
  estimateSizeRef.current = estimateItemSize;
  // 稳定身份：日期标题与记录卡高度不同，标题按定值、记录按传入估高。
  const getItemKey = useCallback(
    (index: number) => rowsRef.current[index]?.key ?? index,
    [],
  );
  const estimateSize = useCallback(
    (index: number) =>
      rowsRef.current[index]?.kind === "heading" ? 44 : estimateSizeRef.current,
    [],
  );

  // 规则针对 React Compiler 的记忆化；本项目未启用编译器（`vite.config.ts` 的
  // `react()` 无 `reactCompiler`，`babel-plugin-react-compiler` 也未安装），
  // 且虚拟列表返回值只在本组件内消费，不传给被记忆化的下游。
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    ...virtualizerObservers,
    scrollMargin,
    estimateSize,
    getItemKey,
    // 触摸滚动一甩就是几屏，默认 1 行缓冲会露白。
    overscan: HISTORY_TIMELINE_OVERSCAN,
    // React 19 下 `flushSync` 会从生命周期里警告（"flushSync was called from inside
    // a lifecycle method"），且每次滚动都同步刷新会拖慢低端设备。虚拟列表的滚动更新
    // 不是关键路径——差一帧只是行位置晚一帧落位——因此关掉它，让 React 自然批处理。
    // 文档把它列为 React 19 兼容与低端设备性能两个场景的推荐做法。
    useFlushSync: false,
    // 时间倒序：最新记录从顶部插入。停在顶部（直播边缘）时用 `start`，新记录顶上来
    // 后视口仍停在 0；向下滚动后切到 `end`，按稳定行键把当前可见行钉在原位。
    anchorTo,
    // 快照里的实测高度与偏移在首帧就位，恢复不经过估高再校正的跳动。
    initialMeasurementsCache: snapshot?.measurements ?? [],
    initialOffset: snapshot?.offset ?? 0,
  });

  // 只有活动面板才跟踪滚动：三条时间线共享一个滚动容器，非活动面板读到的偏移
  // 属于别的视图，记下来会污染它自己的快照。
  useEffect(() => {
    if (!active || !scroller) return;
    const onScroll = () => {
      offsetRef.current = scroller.scrollTop;
      setAnchorTo(historyAnchorTo(scroller.scrollTop));
    };
    // 初次同步：挂载时容器可能已被上一次会话停在非零位置。
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [active, scroller]);

  // 刷新回顶：用户主动刷新＝想看最新，而锚定会把新记录留在视口上方。
  //
  // `anchorTo:"end"` 锚定的语义是「把旧的第一条可见行钉在原位」：新记录从顶部插入
  // 后，虚拟列表把 scrollTop 加上新记录的高度，锚点行看着没动，真正新的那几条却落
  // 在视口上方（负偏移）——刷新于是像什么都没发生。下拉刷新只能在 scrollTop <= 0
  // 起手，而 8px 容差允许用户在 5px 处就已切到 "end"，这个窗口真实存在。
  // 归零后由 onScroll 把锚点方向一并带回 "start"，视口停在 0，新记录自然可见。
  const scrollToTopOnRefresh = useCallback(() => {
    if (!scroller) return;
    // 先于 scrollTo 写 ref：滚动事件异步派发，晚写会让快照的清理逻辑
    // 记下归零前的旧偏移。
    offsetRef.current = 0;
    setAnchorTo(historyAnchorTo(0));
    scroller.scrollTo({ top: 0 });
  }, [scroller]);
  useEffect(() => {
    registerHistoryRefreshScrollReset(refreshResetToken, scrollToTopOnRefresh);
    return () => registerHistoryRefreshScrollReset(refreshResetToken, null);
  }, [refreshResetToken, scrollToTopOnRefresh]);

  // 离开或切视图前拍下快照。偏移取持续跟踪的值而不是此刻的 `scrollTop`：
  // 面板高度收为 0 之后浏览器会把滚动位置钳到 0，那时再读就丢了用户真实位置。
  useEffect(() => {
    if (!active || !scroller) return;
    return () => {
      saveHistoryScrollSnapshot(snapshotKey, {
        measurements: virtualizer.takeSnapshot(),
        offset: offsetRef.current,
      });
    };
  }, [active, scroller, snapshotKey, virtualizer]);

  // 恢复：本视图重新成为活动页时，把上次离开时的偏移写回共享容器。用 layout 阶段
  // 写入，赶在首帧绘制前落位，用户看不到中间态。
  useLayoutEffect(() => {
    if (!active || !scroller) return;
    const offset = offsetRef.current;
    if (offset > 0) scroller.scrollTop = offset;
  }, [active, scroller]);

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div
      ref={bindList}
      data-slot="history-timeline"
      className="relative w-full"
      style={{ height: active ? virtualizer.getTotalSize() : 0 }}
    >
      {virtualRows.map((virtualRow: VirtualItem) => {
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
