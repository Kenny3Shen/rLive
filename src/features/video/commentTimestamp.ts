/** 评论正文切片；URL 与表情由上层先分离，不在这里解释。 */
export type CommentTimestampSegment =
  | { kind: "text"; text: string }
  | { kind: "timestamp"; text: string; seconds: number };

/**
 * 识别 m:ss / h:mm:ss（兼容全角冒号），保留原文与换行。
 * 先吃完整冒号数字串再验证，避免把 1:99:23、1:2:03 等非法串截成有效后缀。
 */
export function commentTimestampSegments(text: string): CommentTimestampSegment[] {
  const segments: CommentTimestampSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\d+(?:[:：]\d+)+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (/[\w.:：/]/.test(text[start - 1] ?? "") || /[\w.:：/]/.test(text[end] ?? "")) {
      continue;
    }
    const parts = match[0].split(/[:：]/);
    if (parts.length !== 2 && parts.length !== 3) continue;
    if (!parts.slice(1).every((part) => /^[0-5]\d$/.test(part))) continue;
    const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
    if (!Number.isSafeInteger(seconds)) continue;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({ kind: "timestamp", text: match[0], seconds });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
