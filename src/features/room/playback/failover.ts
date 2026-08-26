/**
 * 纯函数的播放失败切换策略。
 *
 * - 当前线路最多重试 `maxRetries` 次（默认 2）。
 * - 随后切换到下一条线路。
 * - 线路耗尽时报告失败。
 */

export type FailoverInput = {
  retryCount: number;
  lineIndex: number;
  lineCount: number;
  /** 切换之前*当前*线路的最大重试次数。 */
  maxRetries?: number;
  /** 由健康策略选出的有序替代线路。`null` 表示已耗尽。 */
  nextLineIndex?: number | null;
};

export type FailoverAction =
  | { type: "retry"; retryCount: number; lineIndex: number; delayMs: number }
  | { type: "next_line"; retryCount: 0; lineIndex: number; delayMs: number }
  | { type: "fail"; message: string };

export function nextFailoverAction(input: FailoverInput): FailoverAction {
  const maxRetries = input.maxRetries ?? 2;
  const lineCount = Math.max(0, input.lineCount);
  const lineIndex = Math.max(0, input.lineIndex);

  if (lineCount <= 0) {
    return { type: "fail", message: "没有可用播放线路" };
  }

  if (input.retryCount < maxRetries) {
    const nextRetry = input.retryCount + 1;
    // 第一次立即重试；第二次等待 1s。
    const delayMs = nextRetry === 1 ? 0 : 1000;
    return {
      type: "retry",
      retryCount: nextRetry,
      lineIndex,
      delayMs,
    };
  }

  if ("nextLineIndex" in input) {
    if (input.nextLineIndex == null) {
      return { type: "fail", message: "播放失败" };
    }
    return {
      type: "next_line",
      retryCount: 0,
      lineIndex: Math.max(0, Math.min(input.nextLineIndex, lineCount - 1)),
      delayMs: 0,
    };
  }

  if (lineIndex < lineCount - 1) {
    return {
      type: "next_line",
      retryCount: 0,
      lineIndex: lineIndex + 1,
      delayMs: 0,
    };
  }

  return { type: "fail", message: "播放失败" };
}
