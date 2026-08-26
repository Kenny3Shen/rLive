/**
 * Bilibili 直播当前普通 Web 输入框的默认值。服务可以按账号下发该策略，
 * 但 rLive 尚无可支持的读取契约。
 */
export const BILIBILI_LIVE_DANMAKU_MAX_UTF16_UNITS = 20;

/** 与官方 Web 输入框相同的 JavaScript String.length 度量。 */
export function bilibiliDanmakuUtf16Units(value: string): number {
  return value.length;
}

/**
 * 在 UTF-16 码元边界截断文本而不切开增补平面字符。`for…of` 迭代的是完整的
 * Unicode 码点，与 String.slice 不同。
 */
export function truncateBilibiliDanmaku(
  value: string,
  maxUnits = BILIBILI_LIVE_DANMAKU_MAX_UTF16_UNITS,
): string {
  let next = "";
  let used = 0;

  for (const character of value) {
    const characterUnits = character.length;
    if (used + characterUnits > maxUnits) break;
    next += character;
    used += characterUnits;
  }

  return next;
}

export function insertBilibiliDanmakuText(
  draft: string,
  text: string,
  selectionStart: number,
  selectionEnd: number,
): { draft: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, draft.length));
  const end = Math.max(start, Math.min(selectionEnd, draft.length));
  const nextDraft = truncateBilibiliDanmaku(`${draft.slice(0, start)}${text}${draft.slice(end)}`);

  return {
    draft: nextDraft,
    caret: Math.min(start + text.length, nextDraft.length),
  };
}
