import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn, formatOnline } from "@/lib/utils";
import { formatRecordingDuration } from "@/features/recording/recording";
import type { VideoDanmakuEntry } from "./videoDanmaku";
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
 * 全量渲染已加载条目，屏外行用 `content-visibility: auto` 跳过渲染，
 * 上万条也不拖垮滚动。点击任意条目（含未来条目）跳到该弹幕出现的播放位置。
 *
 * 跟随行是播放头所在的那一行，通常在列表中部，所以「贴底」在这里既不是跟随
 * 目标也不是恢复信号（那是直播增量列表的语义）。一旦用户自己滚动就停下，
 * 只有显式意图才恢复：点「回到当前进度」、点条目跳转、拖动进度条。判定与
 * 几何在 `videoDanmakuFollow.ts`，此处只负责接线。
 */

export function VideoDanmakuList({
  entries,
  positionMs,
  loading,
  onSeek,
  active = true,
}: {
  /** 已加载并合并排序的全部弹幕条目（播放页的 danmakuEntries）。 */
  entries: readonly VideoDanmakuEntry[];
  /** 当前播放位置（毫秒），按它跟踪滚动。 */
  positionMs: number;
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<HTMLLIElement | null>(null);
  // 最近一次跟随滚动写下的 scrollTop：scroll 事件拿它作锚点区分「我滚的」和
  // 「用户滚的」。滚动事件是异步派发的，无法靠标志位在同一帧内消费掉。
  const followAnchorRef = useRef(0);
  const [following, setFollowing] = useState(true);

  // 全量渲染：行级 content-visibility 让浏览器跳过屏外行的布局与绘制，
  // 滚动可以到达任意位置（进度窗口截断会让"滚动查看更多"失效）。
  const total = entries.length;
  const followIndex = videoDanmakuFollowIndex(entries, positionMs);

  /** 把跟随行滚到视口中央，并把落点记为新锚点。 */
  const scrollToFollowRow = useCallback(() => {
    const viewport = viewportRef.current;
    const row = followRef.current;
    if (!viewport || !row) return;
    const target = videoDanmakuFollowScrollTop({
      // offsetTop 的参照是最近的定位祖先，未必是滚动内容；用两个矩形之差加上
      // 当前 scrollTop 换算，对任何嵌套层级都成立。
      rowTop: row.getBoundingClientRect().top - viewport.getBoundingClientRect().top +
        viewport.scrollTop,
      rowHeight: row.offsetHeight,
      viewportHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
    });
    viewport.scrollTop = target;
    // 回读而不是记 target：越界目标会被浏览器夹住，小数位也可能被取整，
    // 记我们「想滚到哪」而不是「实际停在哪」会让下一个 scroll 事件自误判。
    followAnchorRef.current = viewport.scrollTop;
  }, []);

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

  // 依赖 followIndex 而不是 positionMs：后者约 4Hz 跳动，每跳都重滚会与
  // content-visibility 的滚动锚定互相推挤；跟随行没换就没有要滚的理由。
  useLayoutEffect(() => {
    if (!active || !following || followIndex < 0) return;
    scrollToFollowRow();
  }, [active, following, followIndex, scrollToFollowRow]);

  // 拖动进度条是对播放头最明确的表态，重新武装跟随。正常播放的步长远小于阈值。
  //
  // 记在 effect 里而不是渲染期：渲染期改 ref 会被 react(refs) 拦下，而换成
  // 「渲染期 setState」那套写法会让 4Hz 的 positionMs 每跳都多跑一遍渲染 ——
  // 这个列表是全量渲染的，上万行时那是实打实的开销。
  const previousPositionRef = useRef(positionMs);
  useEffect(() => {
    const previous = previousPositionRef.current;
    previousPositionRef.current = positionMs;
    // 已经在跟随时 setState 同值，React 自己会跳过重渲染。
    if (isVideoDanmakuSeek(previous, positionMs)) setFollowing(true);
  }, [positionMs]);

  return (
    <div className="relative h-full">
      <div
        ref={viewportRef}
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
        <ol className="flex flex-col gap-0.5 px-3 py-2 text-sm">
          {entries.map((entry, index) => (
            <li
              key={`${entry.progressMs}-${index}`}
              ref={index === followIndex ? followRef : undefined}
              className={cn(
                // 屏外行跳过布局与绘制：全量渲染上万条也保持滚动流畅；
                // contain-intrinsic-size 提供 scrollHeight 估算避免滚动条抖动。
                "[content-visibility:auto] [contain-intrinsic-size:auto_1.75rem]",
                entry.progressMs > positionMs && "opacity-55",
              )}
            >
              {/* 整行是跳转入口（含未来条目）：点了就走 seek，列表随后跟随
                  新位置滚动。按钮语义让键盘/读屏也能跳。 */}
              <button
                type="button"
                onClick={() => {
                  // 点条目是对播放头的显式表态：先武装跟随，seek 之后的新位置
                  // 就由跟随逻辑接手（否则点完一条就停在原地不再跟）。
                  setFollowing(true);
                  onSeek(entry.progressMs);
                }}
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
          ))}
        </ol>
        {total > 0 && (
          <p className="px-3 pt-1 text-center text-[11px] text-muted-foreground">
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
