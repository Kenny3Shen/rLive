/** 播放中 `currentTime` 发布到 Player store 的最小间隔（约 10Hz）。 */
export const TIME_PUBLISH_INTERVAL_MS = 100;

/**
 * 节流「仅 currentTime」的高频写入。
 *
 * Video.js 的 time feature 播放时每个 RAF 都写一次 `currentTime`，进度条和时间文本
 * 因而每秒触发 60–120 次 React 提交。门控只放行距上次发布满间隔的写入；被拦下的值
 * 不需要补发，下一帧 RAF 会带着更新的时间再来。
 */
export function createTimePublishGate(intervalMs = TIME_PUBLISH_INTERVAL_MS) {
  let lastPublishedAt = Number.NEGATIVE_INFINITY;
  return {
    /** 播放中的逐帧写入：满间隔才放行。 */
    shouldPublish(now: number): boolean {
      if (now - lastPublishedAt < intervalMs) return false;
      lastPublishedAt = now;
      return true;
    },
    /** 事件驱动的完整同步（seek、暂停、结束、时长变化）总是立即发布，并重置节拍。 */
    markPublished(now: number): void {
      lastPublishedAt = now;
    },
  };
}

/** 写入是否只有 `currentTime` 一个字段，即 RAF 逐帧路径。 */
export function isCurrentTimeOnlyPatch(patch: object): boolean {
  const keys = Object.keys(patch);
  return keys.length === 1 && keys[0] === "currentTime";
}
