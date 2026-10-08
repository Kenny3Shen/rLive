import { useMemo, type RefObject } from "react";
import { VideoChapterMenu } from "@/features/video/VideoChapterMenu";
import { playableChapters } from "@/features/video/videoChapters";
import type { VideoChapter } from "@/shared/types/video";
import { useShortsSeekTime } from "./shortsSeekPlayer";

/**
 * 竖屏流的章节入口：与播放页移动端同一个胶囊（`VideoChapterMenu variant="pill"`）。
 *
 * 时间读写走 `ShortsSeekPlayer` 的 store（活动槽位的 `<video>` 已由 `ShortsSeekBridge`
 * 桥接），因此必须渲染在 `ShortsSeekPlayer` 之内；跳转不改变播放/暂停。
 */
export function ShortsChapterMenu({
  chapters,
  open,
  onOpenChange,
  container,
}: {
  chapters: readonly VideoChapter[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: RefObject<HTMLElement | null>;
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
    <VideoChapterMenu
      variant="pill"
      chapters={items}
      currentTime={time.currentTime}
      open={open}
      onOpenChange={onOpenChange}
      onSeek={seek}
      container={container}
    />
  );
}
