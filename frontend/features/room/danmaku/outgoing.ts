/**
 * Bilibili Live's current ordinary-web-composer default. The service can
 * provide this policy per account, but rLive has no supported read contract
 * for that value yet.
 */
export const BILIBILI_LIVE_DANMAKU_MAX_UTF16_UNITS = 20;

/** Matches the official web composer's JavaScript String.length metric. */
export function bilibiliDanmakuUtf16Units(value: string): number {
  return value.length;
}

/**
 * Caps text at a UTF-16-unit boundary without slicing through an astral
 * character. `for…of` yields whole Unicode code points, unlike String.slice.
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
