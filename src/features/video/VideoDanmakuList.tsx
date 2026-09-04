import { useEffect, useRef, useState } from "react";
import { ChevronDown, MessageSquare } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn, formatOnline } from "@/lib/utils";
import { formatRecordingDuration } from "@/features/recording/recording";
import type { VideoDanmakuEntry } from "./videoDanmaku";

/**
 * 侧栏弹幕查看列表：按时间排列当前播放位置附近已加载的 VOD 弹幕。
 *
 * 与直播的 `DanmakuPanel` 不是同一个问题：那是 WebSocket 信息流（增量、
 * 有界队列、回显自证）；这里是静态段数据（一次取回、总量有限、按进度
 * 定位）。刻意保持轻量 —— 折叠态只是一行标题。
 *
 * 默认折叠（B 站 Web 的侧栏同款落点）：相关视频上方一行，点击展开后
 * 显示当前进度附近的弹幕，随播放自动滚动跟踪。
 */

/** 展开后最多渲染的行数：只看进度附近，不渲染全量。 */
const VISIBLE_WINDOW = 120;
/** 跟随播放滚动后，进度行之下保留的行数。 */
const FOLLOW_LEAD = 24;

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
  /** 当前播放位置（毫秒），展开态按它跟踪滚动。 */
  positionMs: number;
  /** 段还在取（首批没回来）。 */
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<HTMLLIElement | null>(null);
  const userScrolledRef = useRef(false);

  // 用户向上翻历史时暂停跟随；滚回底部附近（含跟随行）恢复。
  useEffect(() => {
    if (!open) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const distanceToBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      userScrolledRef.current = distanceToBottom > 80;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [open]);

  useEffect(() => {
    if (!open || userScrolledRef.current) return;
    followRef.current?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [open, positionMs]);

  // 只渲染进度附近的窗口：全量渲染上万条弹幕只会拖垮滚动。
  const total = entries.length;
  const firstAtOrAfter =
    entries.length === 0
      ? 0
      : lowerBound(entries, positionMs - FOLLOW_LEAD * 4_000);
  const windowStart = Math.max(0, firstAtOrAfter - VISIBLE_WINDOW + FOLLOW_LEAD);
  const windowEnd = Math.min(total, firstAtOrAfter + FOLLOW_LEAD);
  const visible = entries.slice(windowStart, windowEnd);

  return (
    <section
      data-slot="video-danmaku-list"
      aria-label="视频弹幕"
      className="shrink-0 border-b border-border/80"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted/50"
      >
        <MessageSquare aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">弹幕</span>
        {open ? (
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground -rotate-90 transition-transform"
          />
        )}
        {!open && total > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatOnline(total)}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={viewportRef}
          className="max-h-64 min-h-0 overflow-y-auto overscroll-contain pb-2"
        >
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
          <ol className="flex flex-col gap-0.5 px-3 text-sm">
            {visible.map((entry, index) => {
              const isFollow = windowStart + index === firstAtOrAfter - 1;
              return (
                <li
                  key={`${entry.progressMs}-${windowStart + index}`}
                  ref={isFollow ? followRef : undefined}
                  className={cn(
                    "flex items-baseline gap-2 rounded-sm px-1 py-0.5",
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
              );
            })}
          </ol>
          {total > visible.length && (
            <p className="px-3 pt-1 text-center text-[11px] text-muted-foreground">
              显示 {windowStart + 1}-{windowEnd} / {total} 条，滚动查看更多
            </p>
          )}
        </div>
      )}
    </section>
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
