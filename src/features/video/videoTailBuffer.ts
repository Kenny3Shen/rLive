/**
 * 「当前分集的最后一个分片是否已经进缓冲」的判定。
 *
 * 下一分集预加载的触发条件就是它：整段还没取完之前，带宽属于正在看的那一集；
 * 只有播放逼近片尾、引擎把最后一片也取回来之后，才轮到下一集的起播字节。
 *
 * 判据取 `HTMLMediaElement.buffered` 的末端而不是「已下载整段」的账本：
 * MSE 下这个值是视频与音频两条轨缓冲区间的**交集**（规范如此），因此末端触到
 * 时长意味着两条轨的末片都已就位。容差比最短的分片时长小得多，足以吸收时间轴
 * 的浮点误差，又不会把「倒数第二片已到」误判成末片已到。
 */

/** 末片判定容差（秒）：小于任何真实分片，只用来吸收时间轴浮点误差。 */
export const VIDEO_TAIL_BUFFER_EPSILON_SECONDS = 0.25;

/** 只用到 TimeRanges 的两个成员，单测因此可以传普通对象。 */
export type BufferedRanges = Pick<TimeRanges, "length" | "end">;

/**
 * 缓冲末端是否已经触到时长（含容差）。
 *
 * 时长未知（0/NaN）时一律判否：无从判断片尾，就不该把「还没取完」当成「已取完」。
 * `end()` 越界会抛 IndexSizeError（TimeRanges 可能被并发清空），失败按未触底处理。
 */
export function isVideoTailBuffered(
  buffered: BufferedRanges | null | undefined,
  duration: number,
): boolean {
  if (!buffered || buffered.length <= 0) return false;
  if (!Number.isFinite(duration) || duration <= 0) return false;
  try {
    return buffered.end(buffered.length - 1) >= duration - VIDEO_TAIL_BUFFER_EPSILON_SECONDS;
  } catch {
    return false;
  }
}
