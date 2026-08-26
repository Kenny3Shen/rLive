/** 用户可见的文本单位，而不是 UTF-16 码元。 */
export const AUTO_DANMAKU_SEND_MAX_GRAPHEMES = 20;

/** 仅限会话的自动发送间隔上下界，整秒计。 */
export const AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS = 10;
export const AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS = 3_600;
export const AUTO_DANMAKU_SEND_DEFAULT_INTERVAL_SECONDS = 20;

/** 两次自动发送请求开始之间的默认间隔。 */
export const AUTO_DANMAKU_SEND_INTERVAL_MS = AUTO_DANMAKU_SEND_DEFAULT_INTERVAL_SECONDS * 1_000;

/** 把可编辑的间隔钳制到受支持的整秒会话范围。 */
export function normalizeAutoDanmakuSendIntervalSeconds(value: number): number {
  if (!Number.isFinite(value)) return AUTO_DANMAKU_SEND_DEFAULT_INTERVAL_SECONDS;
  return Math.min(
    AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS,
    Math.max(AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS, Math.round(value)),
  );
}

/**
 * 基于单调时钟读数计算安全等待。倒退的时钟取值视为没有经过时间，
 * 绝不能被视为提前发送的许可。
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
  /** 经过空白字符安全化处理、可用于单行发送命令的输入。 */
  normalized: string;
  /** 各自通过所选平台校验的有序消息列表。 */
  segments: string[];
  /** 阻止自动发送的本地校验错误。 */
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
 * 发送命令只接受单行。一致地处理所有用户输入的空白字符，
 * 包括粘贴的换行和制表符分隔的文本。
 */
export function normalizeAutoDanmakuText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * `Intl.Segmenter` 遵循 Unicode 字素簇边界，家族 emoji、旗帜或字母加组合符号
 * 绝不会跨两条消息被拆开。若内嵌浏览器缺少它，则禁用自动发送，
 * 而不是静默回退到码点切分。
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

/** JavaScript String.length 正是发送命令执行的同一套 UTF-16 度量。 */
export function utf16Units(value: string): number {
  return value.length;
}

/**
 * 把一份会话草稿拆分为可发送的消息。每个分段至多包含二十个用户可见字符，
 * 且必须同时低于平台的 UTF-16 上限。单个超限字素无法安全切分，
 * 因此上报给用户，而不是构造非法请求。
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

/** 返回下一个有序分段，越过最后一个后从头循环。 */
export function nextAutoDanmakuSegmentIndex(currentIndex: number, segmentCount: number): number {
  if (segmentCount <= 0) return 0;
  return (Math.max(0, currentIndex) + 1) % segmentCount;
}
