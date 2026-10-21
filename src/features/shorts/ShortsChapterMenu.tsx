import { useMemo, type RefObject } from "react";
import { VideoChapterMenu } from "@/features/video/VideoChapterMenu";
import { DrawerScope } from "@/components/ui/drawer";
import { activeChapterIndex, playableChapters } from "@/features/video/videoChapters";
import { isMobileClient } from "@/shared/clientPlatform";
import type { VideoChapter } from "@/shared/types/video";
import { useShortsSeekTime } from "./shortsSeekPlayer";

/**
 * 竖屏流的章节入口：与播放页移动端同一个胶囊（`VideoChapterMenu variant="pill"`）。
 *
 * 时间读写走 `ShortsSeekPlayer` 的 store（活动槽位的 `<video>` 已由 `ShortsSeekBridge`
 * 桥接），因此必须渲染在 `ShortsSeekPlayer` 之内；跳转不改变播放/暂停。
 *
 * 移动客户端或紧凑视口下与播放页一致改走抽屉：竖屏从底部、横屏从右侧。
 */
export function ShortsChapterMenu({
  chapters,
  open,
  onOpenChange,
  container,
  compact = false,
}: {
  chapters: readonly VideoChapter[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: RefObject<HTMLElement | null>;
  /** 紧凑视口（窄屏或矮横屏）；由页面传入，与 `compact` 控制栏同一判据。 */
  compact?: boolean;
}) {
  const time = useShortsSeekTime();
  const duration = time?.duration ?? 0;
  const items = useMemo(() => playableChapters(chapters, duration), [chapters, duration]);
  if (!time || items.length === 0) return null;
  const seek = (target: number) => {
    // 与播放页 `seekTo` 同一余量：正好落在 duration 会被当成播放结束。
    const clamped = Math.max(0, duration > 0 ? Math.min(target, duration - 0.25) : target);
    void time.seek(clamped);
  };
  return (
    // 独立 scope 不设 DrawerViewport，避免继承关闭时高度为 0 的评论 dock。
    // 章节抽屉始终使用显式传入的播放视口；桌面 Popover 不受影响。
    <DrawerScope>
      <VideoChapterMenu
        variant="pill"
        presentation={isMobileClient() || compact ? "drawer" : "popover"}
        chapters={items}
        activeIndex={activeChapterIndex(items, time.currentTime)}
        open={open}
        onOpenChange={onOpenChange}
        onSeek={seek}
        container={container}
      />
    </DrawerScope>
  );
}
