import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn, formatOnline } from "@/lib/utils";
import { formatRecordingDuration } from "@/features/recording/recording";
import { firstVideoDanmakuAtOrAfter, type VideoDanmakuEntry } from "./videoDanmaku";
import { usePlaybackClock, type PlaybackClock } from "./videoPlaybackClock";
import {
  isVideoDanmakuSeek,
  isVideoDanmakuUserScroll,
  isVideoDanmakuVerticalDrag,
  videoDanmakuFollowIndex,
  videoDanmakuFollowScrollTop,
} from "./videoDanmakuFollow";

/**
 * 侧栏「弹幕」选项卡面板：按时间排列当前播放位置附近已加载的 VOD 弹幕。
 *
 * 与直播的 `DanmakuPanel` 不是同一个问题：那是 WebSocket 信息流（增量、
 * 有界队列、回显自证）；这里是静态段数据（一次取回、总量有限、按进度
 * 定位）。
 *
 * 面板自持滚动视口（跟随播放需要独占滚动位置，不与外层页签容器共享）；
 * 已加载条目全部可滚动到达，但只挂载可视区及前后缓冲行。不能用行级
 * `content-visibility: auto` 代替虚拟化：Chromium 每帧都为每个这样的元素做相交计算，
 * Android 实测 5 876 行在播放时仅此一项就占主线程约 470 ms/s，且全屏、页签不可见时照算。
 * 点击任意条目（含未来条目）跳到该弹幕出现的播放位置。
 *
 * 跟随行是播放头所在的那一行，通常在列表中部，所以「贴底」在这里既不是跟随
 * 目标也不是恢复信号（那是直播增量列表的语义）。一旦用户自己滚动就停下，
 * 只有显式意图才恢复：点「回到当前进度」、点条目跳转、拖动进度条。判定与
 * 几何在 `videoDanmakuFollow.ts`，此处只负责接线。
 */

/** 单行实测约 26.75px（11px 时间戳 + leading-relaxed 正文 + py-0.5），取整避免估高修正。 */
const VIDEO_DANMAKU_ROW_ESTIMATE_PX = 27;
const VIDEO_DANMAKU_LIST_OVERSCAN = 8;

export function VideoDanmakuList({
  entries,
  clock,
  loading,
  onSeek,
  active = true,
}: {
  /** 已加载并合并排序的全部弹幕条目（播放页的 danmakuEntries）。 */
  entries: readonly VideoDanmakuEntry[];
  /**
   * 播放进度 store（秒）。只订阅派生下标（跟随行、已出现边界），下标不变时不重渲染；
   * 非活动页签不订阅，横滑条带里看不见的列表不随播放刷新。
   */
  clock: PlaybackClock;
  /** 段还在取（首批没回来）。 */
  loading: boolean;
  /** 点击条目跳到该弹幕出现的播放位置（毫秒）。 */
  onSeek: (positionMs: number) => void;
  /**
   * 本面板是否为当前选中页签。
   *
   * 侧栏把所有页签常驻在横滑条带里，非活动面板只是被移出视口而没有卸载。
   * 此时 `scrollIntoView` 会连带滚动祖先容器去"露出"那个横向偏移过的面板，
   * 把条带的位置搅乱；跟随播放进度也没有意义，因为用户根本没在看这一页。
   */
  active?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // 虚拟器需要在视口挂载后重新取滚动元素，ref 同时存一份 state。
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const setViewportRef = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    setViewport(element);
  }, []);
  const listRef = useRef<HTMLOListElement | null>(null);
  // 最近一次跟随滚动写下的 scrollTop：scroll 事件拿它作锚点区分「我滚的」和
  // 「用户滚的」。滚动事件是异步派发的，无法靠标志位在同一帧内消费掉。
  const followAnchorRef = useRef(0);
  const [following, setFollowing] = useState(true);

  // 不截断进度窗口：滚动可以到达任意已加载位置，只是 DOM 只挂可视行。
  const total = entries.length;
  const followIndex = usePlaybackClock(
    clock,
    (seconds) => videoDanmakuFollowIndex(entries, seconds * 1_000),
    active,
  );
  // 第一条尚未出现（progressMs > 当前进度）的下标；其后整段淡化。
  const futureFrom = usePlaybackClock(
    clock,
    (seconds) => firstVideoDanmakuAtOrAfter(entries, Math.floor(seconds * 1_000) + 1),
    active,
  );
  // 行组件 memo 依赖稳定的点击回调；onSeek 由播放页内联创建。
  const onSeekRef = useRef(onSeek);
  useLayoutEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);
  const selectEntry = useCallback((progressMs: number) => {
    // 点条目是对播放头的显式表态：先武装跟随，seek 之后的新位置
    // 就由跟随逻辑接手（否则点完一条就停在原地不再跟）。
    setFollowing(true);
    onSeekRef.current(progressMs);
  }, []);

  const getItemKey = useCallback((index: number) => entries[index]?.id ?? index, [entries]);
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: total,
    // 非活动期间仍保留滚动元素，让前插分段可按稳定 key 保持阅读位置；
    // 只断开元素会让 anchorTo 跳过保位，重新激活后落在旧像素而非旧阅读行。
    // 行 DOM 由下方 active 显式门控，非活动时仍然零行。
    getScrollElement: () => viewport,
    estimateSize: () => VIDEO_DANMAKU_ROW_ESTIMATE_PX,
    getItemKey,
    paddingStart: 8,
    paddingEnd: 8,
    gap: 2,
    overscan: VIDEO_DANMAKU_LIST_OVERSCAN,
    // 不跟随时分段插到前面，保持阅读行原位；不追加跟随，跟随行由下方居中逻辑决定。
    anchorTo: "end",
    useFlushSync: false,
  });
  const totalSize = virtualizer.getTotalSize();
  // 非活动页签保留虚拟器的阅读锚点，但不挂载可视范围内的行。
  const virtualRows = active ? virtualizer.getVirtualItems() : [];

  /** 把跟随行滚到视口中央，并把落点记为新锚点。 */
  const scrollToFollowRow = useCallback(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    // 跟随行通常尚未挂载：位置取虚拟器的测量缓存（已测行为实测值，其余为估高）。
    const item = virtualizer.measurementsCache[followIndex];
    if (!viewport || !list || !item) return;
    const target = videoDanmakuFollowScrollTop({
      // 列表在滚动内容里的偏移用两个矩形之差加 scrollTop 换算，与嵌套层级无关。
      rowTop: list.getBoundingClientRect().top - viewport.getBoundingClientRect().top +
        viewport.scrollTop + item.start,
      rowHeight: item.size,
      viewportHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
    });
    viewport.scrollTop = target;
    // 回读而不是记 target：越界目标会被浏览器夹住，小数位也可能被取整，
    // 记我们「想滚到哪」而不是「实际停在哪」会让下一个 scroll 事件自误判。
    followAnchorRef.current = viewport.scrollTop;
  }, [followIndex, virtualizer]);

  // 只在本页签活动时听：非活动期间跟随 effect 提前返回、锚点因此停在旧值，而分段
  // 懒加载仍在改 scrollHeight，滚动锚定会派发位移很大的 scroll 事件 —— 用户还没
  // 打开弹幕页签，跟随就已经被自己关掉了。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !active) return;
    const stopFollowing = () => setFollowing(false);
    const onScroll = () => {
      // 锚点固定不动，位移因此可以跨多个事件累积：慢速拖动的每一小步都在容差内，
      // 逐事件更新锚点就永远判不出用户滚动。
      if (isVideoDanmakuUserScroll(viewport.scrollTop, followAnchorRef.current)) {
        stopFollowing();
      }
    };
    // 触摸要按方向判：本视口同时是侧栏横滑切页签的起手区，见
    // `isVideoDanmakuVerticalDrag`。只记起点，不在这里 preventDefault，
    // 横滑照旧由 useHorizontalSwipe 接管。
    let originX = 0;
    let originY = 0;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      originX = touch.clientX;
      originY = touch.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      if (isVideoDanmakuVerticalDrag(touch.clientX - originX, touch.clientY - originY)) {
        stopFollowing();
      }
    };
    // 滚轮是无歧义的用户意图，立即停下跟随而不等位移累积过阈值：触控板一次只滚几 px，
    // 靠阈值会让手势开头几下被跟随逻辑反复拽回去。
    // scroll 那条仍然要留着 —— 拖滚动条和键盘翻页不派发指针类事件。
    viewport.addEventListener("wheel", stopFollowing, { passive: true });
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: true });
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", stopFollowing);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [active]);

  // 依赖 followIndex 而不是播放进度：后者约 4Hz 跳动，跟随行没换就没有要滚的理由。
  // 视口刚挂载或总高度变化（分段到达、实测修正估高）时也要重新居中。
  useLayoutEffect(() => {
    if (!active || !following || followIndex < 0) return;
    scrollToFollowRow();
  }, [active, following, followIndex, scrollToFollowRow, totalSize, viewport]);

  // 拖动进度条是对播放头最明确的表态，重新武装跟随。正常播放的步长远小于阈值。
  //
  // 直接订阅 store 而不经渲染：只为判定 seek 没必要按 4Hz 进度逐跳重渲染列表。
  // 非活动页签也照常判定，切回时跟随已重新武装。
  useEffect(() => {
    let previous = clock.get() * 1_000;
    return clock.subscribe(() => {
      const next = clock.get() * 1_000;
      const seeked = isVideoDanmakuSeek(previous, next);
      previous = next;
      // 已经在跟随时 setState 同值，React 自己会跳过重渲染。
      if (seeked) setFollowing(true);
    });
  }, [clock]);

  return (
    <div className="relative h-full">
      <div
        ref={setViewportRef}
        data-slot="video-danmaku-list"
        aria-label="视频弹幕"
        // touch-pan-y：本视口位于侧栏横滑条带内，滚动容器必须让出横向，
        // 否则合成器会把横滑当作纵向滚动接走并 pointercancel（见 VideoSidebar 页签面板）。
        className="h-full overflow-y-auto overscroll-contain pb-2 touch-pan-y"
      >
        {total === 0 && loading && (
          <div className="flex items-center justify-center py-4">
            <Spinner className="size-4" aria-label="正在加载弹幕" />
          </div>
        )}
        {total === 0 && !loading && (
          <p className="py-4 text-center text-xs text-muted-foreground">当前位置附近暂无弹幕</p>
        )}
        <ol
          ref={listRef}
          data-count={total}
          className="relative text-sm"
          // 行绝对定位，原生滚动锚定无从依附；位置保持交给虚拟器的 anchorTo。
          style={{ height: total > 0 ? totalSize : 0, overflowAnchor: "none" }}
        >
          {virtualRows.map((virtualRow: VirtualItem) => {
            const entry = entries[virtualRow.index];
            if (!entry) return null;
            return (
              <VideoDanmakuRow
                key={virtualRow.key}
                index={virtualRow.index}
                start={virtualRow.start}
                measureRef={virtualizer.measureElement}
                entry={entry}
                future={virtualRow.index >= futureFrom}
                onSelect={selectEntry}
              />
            );
          })}
        </ol>
        {total > 0 && (
          <p className="px-3 pt-1 text-center text-xs text-muted-foreground">
            共 {formatOnline(total)} 条弹幕
          </p>
        )}
      </div>

      {/* 恢复跟随的唯一显式入口。渲染在滚动视口之外：放在视口里会随内容滚走，
          也会把自己算进 scrollHeight。 */}
      {active && !following && total > 0 && (
        <Button
          data-mobile-static-backdrop
          type="button"
          aria-label="回到当前进度"
          title="回到当前进度"
          onClick={() => setFollowing(true)}
          className="absolute right-2.5 bottom-2.5 z-10 size-10 rounded-full border border-border/80 bg-background/90 p-0 shadow-lg shadow-black/20 backdrop-blur animate-in fade-in"
        >
          <LocateFixed className="size-4.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}

/**
 * 单行 memo：播放推进时只有跨过「已出现」边界的那几行重渲染。
 * 行高由 `measureElement` 实测；正文单行截断，估高只用于尚未挂载的行。
 */
const VideoDanmakuRow = memo(function VideoDanmakuRow({
  index,
  start,
  measureRef,
  entry,
  future,
  onSelect,
}: {
  index: number;
  start: number;
  measureRef: (element: HTMLLIElement | null) => void;
  entry: VideoDanmakuEntry;
  future: boolean;
  onSelect: (progressMs: number) => void;
}) {
  return (
    <li
      ref={measureRef}
      data-index={index}
      data-entry-id={entry.id}
      className={cn("absolute inset-x-3 top-0", future && "opacity-55")}
      style={{ transform: `translateY(${start}px)` }}
    >
      {/* 整行是跳转入口（含未来条目）：点了就走 seek，列表随后跟随
          新位置滚动。按钮语义让键盘/读屏也能跳。 */}
      <button
        type="button"
        onClick={() => onSelect(entry.progressMs)}
        title="跳转到此弹幕的位置"
        className="flex w-full cursor-pointer items-baseline gap-2 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-muted/60"
      >
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatRecordingDuration(entry.progressMs)}
        </span>
        <span
          className="min-w-0 flex-1 truncate leading-relaxed"
          style={entry.color ? { color: entry.color } : undefined}
        >
          {entry.content}
        </span>
      </button>
    </li>
  );
});
