import type { VideoChapter } from "@/shared/types/video";

/**
 * 控制栏章节菜单可列出的章节：与章节轨同一组后端归一化数据，只剔除无法定位的项。
 * 零长区间不进章节轨，起点已越过实际时长的章节在进度条上不存在，菜单也不列出。
 */
export function playableChapters(
  chapters: readonly VideoChapter[] | undefined,
  duration: number,
): VideoChapter[] {
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return (chapters ?? []).filter(
    (chapter) =>
      Number.isFinite(chapter.start_time) &&
      Number.isFinite(chapter.end_time) &&
      chapter.end_time > chapter.start_time &&
      chapter.start_time < limit,
  );
}

/**
 * 当前播放位置所在章节的下标；落在章节间隙或首章之前时为 -1。
 * 与进度条一致：未被章节覆盖的时间不沿用上一章；区间重叠时取起点较晚的一章。
 */
export function activeChapterIndex(chapters: readonly VideoChapter[], time: number): number {
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    const chapter = chapters[index];
    if (time >= chapter.start_time && time < chapter.end_time) return index;
  }
  return -1;
}
