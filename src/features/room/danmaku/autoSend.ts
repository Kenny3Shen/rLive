/** A user-visible text unit, not a UTF-16 code unit. */
export const AUTO_DANMAKU_SEND_MAX_GRAPHEMES = 15;

/** Session-only automatic-send interval bounds, in whole seconds. */
export const AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS = 10;
export const AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS = 3_600;
export const AUTO_DANMAKU_SEND_DEFAULT_INTERVAL_SECONDS = 20;

/** The default interval between two automatic-send request starts. */
export const AUTO_DANMAKU_SEND_INTERVAL_MS = AUTO_DANMAKU_SEND_DEFAULT_INTERVAL_SECONDS * 1_000;

/** Clamp an editable interval to the supported whole-second session range. */
export function normalizeAutoDanmakuSendIntervalSeconds(value: number): number {
  if (!Number.isFinite(value)) return AUTO_DANMAKU_SEND_DEFAULT_INTERVAL_SECONDS;
  return Math.min(
    AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS,
    Math.max(AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS, Math.round(value)),
  );
}

/**
 * Calculate a safe wait from a monotonic clock reading. A clock value that
 * moves backwards is treated as no elapsed time, never as permission to send
 * early.
 */
export function remainingAutoDanmakuSendDelay(
  lastStartedAt: number | null,
  now: number,
  intervalMs = AUTO_DANMAKU_SEND_INTERVAL_MS,
): number {
  if (lastStartedAt === null) return 0;
  const elapsed = Math.max(0, now - lastStartedAt);
  return Math.max(0, intervalMs - elapsed);
}

export type AutoDanmakuText = {
  /** Input after whitespace has been made safe for single-line send commands. */
  normalized: string;
  /** Ordered messages that are individually valid for the selected platform. */
  segments: string[];
  /** A local validation error that prevents automatic sending. */
  error: string | null;
};

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The send commands only accept a single line. Treat all user-entered
 * whitespace consistently, including pasted newlines and tab-separated text.
 */
export function normalizeAutoDanmakuText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * `Intl.Segmenter` follows Unicode grapheme-cluster boundaries, so a family
 * emoji, a flag, or a letter plus combining marks is never split between two
 * outgoing messages. If the embedded browser lacks it, automatic sending is
 * disabled rather than silently falling back to code-point splitting.
 */
export function splitGraphemes(
  value: string,
  Segmenter: typeof Intl.Segmenter | null = typeof Intl.Segmenter === "function"
    ? Intl.Segmenter
    : null,
): string[] | null {
  if (!Segmenter) return null;

  const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(value), ({ segment }) => segment);
}

/** JavaScript String.length is the same UTF-16 metric enforced by the send commands. */
export function utf16Units(value: string): number {
  return value.length;
}

/**
 * Split one session draft into sendable messages. A segment can contain at
 * most fifteen user-visible characters and must also stay under the platform
 * UTF-16 bound. A single over-limit grapheme cannot be safely split, so it is
 * reported to the user instead of creating an invalid request.
 */
export function splitAutoDanmakuText(value: string, maxUtf16Units: number): AutoDanmakuText {
  const normalized = normalizeAutoDanmakuText(value);
  if (!normalized) {
    return { normalized, segments: [], error: "请输入要自动发送的弹幕内容。" };
  }

  if (!Number.isSafeInteger(maxUtf16Units) || maxUtf16Units < 1) {
    return { normalized, segments: [], error: "当前平台的弹幕长度限制不可用。" };
  }

  if (hasControlCharacter(normalized)) {
    return { normalized, segments: [], error: "弹幕不能包含控制字符。" };
  }

  const segments: string[] = [];
  let current = "";
  let graphemeCount = 0;
  let currentUtf16Units = 0;

  const graphemes = splitGraphemes(normalized);
  if (!graphemes) {
    return {
      normalized,
      segments: [],
      error: "当前运行环境不支持按用户可见字符拆分，请更新 WebView2 后再试。",
    };
  }

  for (const grapheme of graphemes) {
    const graphemeUtf16Units = utf16Units(grapheme);
    if (graphemeUtf16Units > maxUtf16Units) {
      return {
        normalized,
        segments: [],
        error: `单个用户可见字符超过单条弹幕 ${maxUtf16Units} 个 UTF-16 字符的限制。`,
      };
    }

    const shouldStartNewSegment =
      graphemeCount >= AUTO_DANMAKU_SEND_MAX_GRAPHEMES ||
      currentUtf16Units + graphemeUtf16Units > maxUtf16Units;
    if (current && shouldStartNewSegment) {
      segments.push(current);
      current = "";
      graphemeCount = 0;
      currentUtf16Units = 0;
    }

    current += grapheme;
    graphemeCount += 1;
    currentUtf16Units += graphemeUtf16Units;
  }

  if (current) segments.push(current);
  return { normalized, segments, error: null };
}

/** Return the next ordered segment, wrapping after the last one. */
export function nextAutoDanmakuSegmentIndex(currentIndex: number, segmentCount: number): number {
  if (segmentCount <= 0) return 0;
  return (Math.max(0, currentIndex) + 1) % segmentCount;
}
