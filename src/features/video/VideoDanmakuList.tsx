import { useEffect, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn, formatOnline } from "@/lib/utils";
import { formatRecordingDuration } from "@/features/recording/recording";
import type { VideoDanmakuEntry } from "./videoDanmaku";

/**
 * 侧栏「弹幕」选项卡面板：按时间排列当前播放位置附近已加载的 VOD 弹幕。
 *
 * 与直播的 `DanmakuPanel` 不是同一个问题：那是 WebSocket 信息流（增量、
 * 有界队列、回显自证）；这里是静态段数据（一次取回、总量有限、按进度
 * 定位）。
 *
 * 面板自持滚动视口（跟随播放需要独占滚动位置，不与外层页签容器共享）；
 * 全量渲染已加载条目，屏外行用 `content-visibility: auto` 跳过渲染，
 * 上万条也不拖垮滚动。用户上翻历史暂停跟随，滚回底部恢复。
 */

function formatTimestamp(progressMs: number): string {
  return formatRecordingDuration(progressMs);
}

export function VideoDanmakuList({
  entries,
  positionMs,
  loading,
}: {
  /** 已加载并合并排序的全部弹幕条目（播放页的 danmakuEntries）。 */
  entries: readonly VideoDanmakuEntry[];
  /** 当前播放位置（毫秒），按它跟踪滚动。 */
  positionMs: number;
  /** 段还在取（首批没回来）。 */
  loading: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<HTMLLIElement | null>(null);
  const userScrolledRef = useRef(false);

  // 用户向上翻历史时暂停跟随；滚回底部附近（含跟随行）恢复。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const distanceToBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      userScrolledRef.current = distanceToBottom > 80;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (userScrolledRef.current) return;
    followRef.current?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [positionMs]);

  // 全量渲染：行级 content-visibility 让浏览器跳过屏外行的布局与绘制，
  // 滚动可以到达任意位置（进度窗口截断会让"滚动查看更多"失效）。
  const total = entries.length;
  const followIndex = Math.max(0, lowerBound(entries, positionMs) - 1);

  return (
    <div
      data-slot="video-danmaku-list"
      aria-label="视频弹幕"
      className="flex h-full min-h-0 flex-col"
    >
      <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
        {total === 0 && loading && (
          <div className="flex items-center justify-center py-4">
            <Spinner className="size-4" aria-label="正在加载弹幕" />
          </div>
        )}
        {total === 0 && !loading && (
          <p className="py-4 text-center text-xs text-muted-foreground">
            当前位置附近暂无弹幕
          </p>
        )}
        <ol className="flex flex-col gap-0.5 px-3 py-2 text-sm">
          {entries.map((entry, index) => (
            <li
              key={`${entry.progressMs}-${index}`}
              ref={index === followIndex ? followRef : undefined}
              className={cn(
                // 屏外行跳过布局与绘制：全量渲染上万条也保持滚动流畅；
                // contain-intrinsic-size 提供 scrollHeight 估算避免滚动条抖动。
                "flex items-baseline gap-2 rounded-sm px-1 py-0.5",
                "[content-visibility:auto] [contain-intrinsic-size:auto_1.75rem]",
                entry.progressMs > positionMs && "opacity-55",
              )}
            >
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {formatTimestamp(entry.progressMs)}
              </span>
              <span
                className="min-w-0 flex-1 truncate leading-relaxed"
                style={entry.color ? { color: entry.color } : undefined}
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ol>
        {total > 0 && (
          <p className="px-3 pt-1 text-center text-[11px] text-muted-foreground">
            共 {formatOnline(total)} 条弹幕
          </p>
        )}
      </div>
    </div>
  );
}

/** 第一条 progressMs >= target 的下标（entries 已按 progressMs 升序）。 */
function lowerBound(
  entries: readonly VideoDanmakuEntry[],
  targetMs: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (entries[mid].progressMs < targetMs) low = mid + 1;
    else high = mid;
  }
  return low;
}
