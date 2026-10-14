import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Check, ChevronUp, ListVideo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { useHoverOpen } from "@/components/videojs/lib/use-hover-open";
import { mediaPopupTriggerOpenClass } from "@/components/videojs/lib/popup-surface";
import {
  glassMutedTextClass,
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassTitleClass,
} from "@/shared/components/player/glassSurface";
import { usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import type { VideoChapter } from "@/shared/types/video";
import { cn } from "@/lib/utils";
import { formatVideoDuration } from "./videoHistory";

export type VideoChapterMenuProps = {
  /** 已按 `playableChapters` 过滤的章节；为空时调用方不渲染本组件。 */
  chapters: readonly VideoChapter[];
  /** 当前章节下标（`activeChapterIndex`），-1 表示不在任何章节内；由调用方按进度订阅。 */
  activeIndex: number;
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
  /**
   * `popover`：桌面悬停/点击展开的锚定弹层；`drawer`：移动客户端或紧凑视口下
   * 从屏幕边缘推入的抽屉（竖屏从底部、横屏从右侧）。
   *
   * 抽屉是触摸端的必要形态：矮舞台上锚定弹层的可用高度不足以放下章节列表，
   * 而胶囊本身只有 28px 高，手指在它旁边稍微偏一点就点到画面上了。
   */
  presentation?: "popover" | "drawer";
};

/**
 * 控制栏章节菜单：列出平台章节，点选后跳到该章起点，不改变播放/暂停状态。
 *
 * 桌面与宽视口走与字幕弹层同族的 Popover（悬停展开、glass、向上展开，入口在左侧，
 * 弹层左对齐）；移动客户端与紧凑视口改走 Drawer。两种形态共用同一份触发器与列表。
 * 当前章节高亮。
 */
export function VideoChapterMenu({
  chapters,
  activeIndex,
  open,
  onOpenChange,
  onSeek,
  container,
  variant = "button",
  presentation = "popover",
}: VideoChapterMenuProps) {
  const hover = useHoverOpen(open, onOpenChange);
  const portrait = usePortraitOrientation();
  const activeTitle = activeIndex >= 0 ? chapters[activeIndex].title : null;
  const listRef = useRef<HTMLDivElement | null>(null);

  // 展开时把当前章节滚进可视区；只调列表自身的 `scrollTop`，不牵动舞台或页面滚动。
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
  /**
   * 定位要跑两次（本帧 + 下一帧）。
   *
   * 弹层展开时 base-ui 会把焦点移到列表里的第一项（触摸时移到弹层本身），而
   * `focus()` 的默认行为会把该元素滚进可视区 —— 第一项就在列表顶部，于是浏览器
   * 把 `scrollTop` 清回 0，正好抹掉我们本帧刚写的位置。再跑一次即可落在焦点之后；
   * 此时列表还在入场动画里，重写不可见。
   */
  const scheduleScrollActiveIntoView = useCallback(() => {
    const first = requestAnimationFrame(() => {
      scrollActiveIntoView();
      second = requestAnimationFrame(scrollActiveIntoView);
    });
    let second = 0;
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [scrollActiveIntoView]);
  useEffect(() => {
    if (!open) return;
    return scheduleScrollActiveIntoView();
  }, [open, scheduleScrollActiveIntoView]);
  // 抽屉列表是挂载时才建 DOM（弹层带 Portal 与进出场动画），回调 ref 里补一次定位。
  const attachList = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      if (!node || !open) return;
      scheduleScrollActiveIntoView();
    },
    [open, scheduleScrollActiveIntoView],
  );

  const selectChapter = (chapter: VideoChapter) => {
    onSeek(chapter.start_time);
    onOpenChange(false);
  };

  const triggerLabel = activeTitle ? `章节：${activeTitle}` : "章节";

  const pill = variant === "pill";
  const drawer = presentation === "drawer";
  // 两种形态共用同一份触发器：抽屉形态只切换开合（触摸端没有悬停，不该被指针离开收起），
  // 弹层形态交给 `PopoverTrigger` 接管开合与悬停。
  const trigger = pill ? (
    <button
      type="button"
      aria-label={triggerLabel}
      aria-expanded={drawer ? open : undefined}
      data-slot="player-chapter-pill"
      className={cn(
        "inline-flex h-7 max-w-[min(18rem,70%)] min-w-0 cursor-pointer touch-manipulation items-center gap-1.5 rounded-full px-2.5 text-sm text-white",
        "bg-black/35 transition-colors hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/70",
        open && "bg-white/20",
      )}
      onClick={drawer ? () => onOpenChange(!open) : undefined}
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
      aria-expanded={drawer ? open : undefined}
      className={cn("r-live-media-extension-button", open && mediaPopupTriggerOpenClass)}
      onClick={drawer ? () => onOpenChange(!open) : undefined}
    >
      <ListVideo aria-hidden />
    </MediaButton>
  );

  const chapterList = (
    <div
      ref={attachList}
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
  );

  if (drawer) {
    return (
      <>
        {trigger}
        <Drawer open={open} onOpenChange={onOpenChange}>
          <DrawerContent
            side={portrait ? "bottom" : "right"}
            container={container}
            glass
            className={cn("flex flex-col gap-0", glassPanelClass({ overlay: true }))}
          >
            <DrawerTitle className={cn("shrink-0 pb-1", glassTitleClass({ overlay: true }))}>
              章节
            </DrawerTitle>
            {chapterList}
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={hover.onOpenChange}>
      <PopoverTrigger {...hover.trigger} render={trigger} />
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
        {chapterList}
      </PopoverContent>
    </Popover>
  );
}
