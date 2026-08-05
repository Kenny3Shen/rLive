/**
 * Pure failover policy ported from Simple Live `mediaError` / `mediaEnd`.
 *
 * - Retry the current line up to `maxRetries` times (default 2).
 * - Then advance to the next line.
 * - When lines are exhausted, report failure.
 */

export type FailoverInput = {
  retryCount: number;
  lineIndex: number;
  lineCount: number;
  /** Max retries of the *current* line before advancing (Simple Live uses 2). */
  maxRetries?: number;
  /** Ranked replacement chosen by health policy. `null` means exhausted. */
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
    // First retry immediate; second waits 1s (Simple Live).
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
