import type { AcfunArticleBlock } from "./acfunTypes";

/** 仅把 HTTP(S) 链接交给系统浏览器，拒绝脚本、数据和其他协议。 */
export function safeHttpLink(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** 页面已有文章标题 h1；正文内的 h1-h6 依次映射为 h2-h6。 */
export function articleHeadingLevel(level: number): 2 | 3 | 4 | 5 | 6 {
  const normalized = Number.isFinite(level) ? Math.trunc(level) : 1;
  return Math.min(6, Math.max(2, normalized + 1)) as 2 | 3 | 4 | 5 | 6;
}

function textKey(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 只在摘要确实重复标题或正文首段时省略它。
 * 摘要与正文不同的文章仍保留摘要，避免按长度或相似度误删编辑内容。
 */
export function articleSummaryForDisplay(
  title: string,
  summary: string,
  blocks: readonly AcfunArticleBlock[],
): string | null {
  const normalized = textKey(summary);
  if (!normalized || normalized === textKey(title)) return null;
  const firstParagraph = blocks.find(
    (block): block is Extract<AcfunArticleBlock, { type: "paragraph" }> =>
      block.type === "paragraph" && Boolean(textKey(block.text)),
  );
  if (firstParagraph && normalized === textKey(firstParagraph.text)) return null;
  return summary.trim() || null;
}

function imageKey(value: string): string | null {
  const href = safeHttpLink(value);
  if (!href) return null;
  const url = new URL(href);
  // 图片显示会把 http 升级为 https；比较时采用同一规则，并忽略 URL 片段。
  url.protocol = "https:";
  url.hash = "";
  return url.href;
}

/** 封面与正文任一图片为同一资源时，只在正文位置渲染一次。 */
export function articleCoverForDisplay(
  cover: string | null | undefined,
  blocks: readonly AcfunArticleBlock[],
): string | null {
  const candidate = cover?.trim();
  if (!candidate) return null;
  const key = imageKey(candidate);
  if (!key) return null;
  const duplicated = blocks.some((block) => block.type === "image" && imageKey(block.url) === key);
  return duplicated ? null : candidate;
}
