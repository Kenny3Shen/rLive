import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Check, ChevronUp, ListVideo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { useHoverOpen } from "@/components/videojs/lib/use-hover-open";
import { mediaPopupTriggerOpenClass } from "@/components/videojs/lib/popup-surface";
import {
  glassMutedTextClass,
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
} from "@/shared/components/player/glassSurface";
import type { VideoChapter } from "@/shared/types/video";
import { cn } from "@/lib/utils";
import { formatVideoDuration } from "./videoHistory";
import { activeChapterIndex } from "./videoChapters";

export type VideoChapterMenuProps = {
  /** 已按 `playableChapters` 过滤的章节；为空时调用方不渲染本组件。 */
  chapters: readonly VideoChapter[];
  currentTime: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 跳到章节起点；沿用页面的 `seekTo`（时长余量、等待态都在那里）。 */
  onSeek: (time: number) => void;
  /** 弹层挂进播放器舞台，画面全屏时才能留在 top layer 内。 */
  container: RefObject<HTMLElement | null>;
  /**
   * `button`：桌面控制栏左组的图标按钮；`pill`：移动端/竖屏进度条上方的胶囊，
   * 直接显示当前章节标题。
   */
  variant?: "button" | "pill";
};

/**
 * 控制栏章节菜单：列出平台章节，点选后跳到该章起点，不改变播放/暂停状态。
 * 与字幕弹层同族（悬停展开、glass、向上展开），入口在左侧，弹层左对齐；当前章节高亮。
 */
export function VideoChapterMenu({
  chapters,
  currentTime,
  open,
  onOpenChange,
  onSeek,
  container,
  variant = "button",
}: VideoChapterMenuProps) {
  const hover = useHoverOpen(open, onOpenChange);
  const activeIndex = activeChapterIndex(chapters, currentTime);
  const activeTitle = activeIndex >= 0 ? chapters[activeIndex].title : null;
  const listRef = useRef<HTMLDivElement | null>(null);

  // 展开时把当前章节滚进可视区；只调列表自身的 scrollTop，不牵动舞台或页面滚动。
  const scrollActiveIntoView = useCallback(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - (list.clientHeight - item.offsetHeight) / 2);
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(scrollActiveIntoView);
    return () => cancelAnimationFrame(frame);
  }, [open, scrollActiveIntoView]);

  const selectChapter = (chapter: VideoChapter) => {
    onSeek(chapter.start_time);
    onOpenChange(false);
  };

  const triggerLabel = activeTitle ? `章节：${activeTitle}` : "章节";

  return (
    <Popover open={open} onOpenChange={hover.onOpenChange}>
      <PopoverTrigger
        {...hover.trigger}
        render={
          variant === "pill" ? (
            <button
              type="button"
              aria-label={triggerLabel}
              data-slot="player-chapter-pill"
              className={cn(
                "inline-flex h-7 max-w-[min(18rem,70%)] min-w-0 cursor-pointer touch-manipulation items-center gap-1.5 rounded-full px-2.5 text-sm text-white",
                "bg-black/35 transition-colors hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/70",
                open && "bg-white/20",
              )}
            >
              <ListVideo className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{activeTitle ?? "章节"}</span>
              <ChevronUp
                className={cn("size-3.5 shrink-0 transition-transform", !open && "rotate-180")}
                aria-hidden
              />
            </button>
          ) : (
            <MediaButton
              aria-label={triggerLabel}
              className={cn("r-live-media-extension-button", open && mediaPopupTriggerOpenClass)}
            >
              <ListVideo aria-hidden />
            </MediaButton>
          )
        }
      />
      <PopoverContent
        container={container}
        side="top"
        align="start"
        // 舞台 overflow-hidden 会裁掉弹层，边界交给默认的裁剪祖先（即舞台）。矮舞台
        // （竖屏小窗）上方空间不足时不翻到下方盖住控制栏，而是保持向上并压缩列表高度。
        collisionPadding={8}
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        sticky
        glass
        aria-label="章节"
        className={cn("flex max-h-[min(24rem,var(--available-height))] w-[min(20rem,calc(100vw-1.5rem))] flex-col gap-0 p-1.5", glassPanelClass({ overlay: true }))}
        {...hover.popup}
      >
        <div
          ref={listRef}
          role="list"
          aria-label="章节列表"
          className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {chapters.map((chapter, index) => {
            const active = index === activeIndex;
            return (
              <div key={`${chapter.start_time}-${index}`} role="listitem">
                <Button
                  variant="ghost"
                  title={chapter.title}
                  aria-current={active || undefined}
                  className={cn(
                    "w-full justify-start gap-3 max-md:h-10",
                    glassOptionClass(),
                    active && glassOptionSelectedClass(),
                  )}
                  onClick={() => selectChapter(chapter)}
                >
                  <span
                    className={cn(
                      "w-14 shrink-0 text-left text-xs tabular-nums",
                      !active && glassMutedTextClass(),
                    )}
                  >
                    {formatVideoDuration(chapter.start_time)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">{chapter.title}</span>
                  {active && <Check data-icon="inline-end" aria-hidden />}
                </Button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
