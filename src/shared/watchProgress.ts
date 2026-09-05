/**
 * 「上次看到第几秒」的共享判定：B 站视频点播与本地录制回放共用。
 *
 * 两个表面的落盘方式不同（`video_history` 按作品去重，`recording_watch_progress`
 * 按录制文件），但「多短的进度算没看、多久写一次盘、离结尾多近算看完」是同一套
 * 语义。各写一份只会让两边的阈值随时间漂移，续播手感因此不一致。
 */

/** 低于此秒数不记进度：点开就退、误触与拖动预览不该污染历史。 */
export const WATCH_PROGRESS_MIN_SECONDS = 3;

/** 两次写盘之间的最小间隔。timeupdate 约 250ms 一次，不节流会写穿 SQLite。 */
export const WATCH_PROGRESS_REPORT_INTERVAL_MS = 5_000;

/** 距结尾这个秒数以内视为看完：续播从头播，而不是卡在最后一帧反复触发 ended。 */
export const WATCH_PROGRESS_FINISHED_TAIL_SECONDS = 5;

/**
 * 这个位置值不值得记住。
 *
 * 暂停/播完/离开这三个「最后一次」的强制写盘绕过节流窗口，但仍要过这一关，
 * 否则点开就退会留下一条 0 秒记录。
 */
export function isWatchProgressWorthKeeping(position: number): boolean {
  return Number.isFinite(position) && position >= WATCH_PROGRESS_MIN_SECONDS;
}

/**
 * 是否该把当前进度写盘。
 *
 * `lastReportedAt` 为 null 表示这一份内容还没上报过 —— 只要越过最小进度就立刻
 * 记一次，让「打开过」这件事尽早落盘（用户可能马上就退出）。
 */
export function shouldReportWatchProgress(
  position: number,
  lastReportedAt: number | null,
  now: number,
): boolean {
  if (!isWatchProgressWorthKeeping(position)) return false;
  if (lastReportedAt === null) return true;
  return now - lastReportedAt >= WATCH_PROGRESS_REPORT_INTERVAL_MS;
}

/**
 * 是否已经看完。
 *
 * `duration` 为 0 表示时长未知（录制被打断、上游没给时长），无从判断结尾，
 * 按没看完处理。容差存在的理由见 `WATCH_PROGRESS_FINISHED_TAIL_SECONDS`。
 */
export function isWatchFinished(progress: number, duration: number): boolean {
  return duration > 0 && progress >= duration - WATCH_PROGRESS_FINISHED_TAIL_SECONDS;
}

/**
 * 这条记录该续播到的秒数；不该续播时返回 0（从头播）。
 *
 * 两种情况从头播：① 进度太短，视为没看；② 已经看完 —— 停在最后一帧会立刻再
 * 触发 ended，续播体验上等于播不了。
 */
export function watchResumePosition(progress: number, duration: number): number {
  if (!isWatchProgressWorthKeeping(progress)) return 0;
  return isWatchFinished(progress, duration) ? 0 : progress;
}
