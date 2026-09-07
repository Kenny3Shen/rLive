import type { ReactNode } from "react";
import { notify } from "@/components/ui/toast";
import { openExternalUrl } from "@/shared/externalUrl";

/**
 * 把纯文本里的 URL 渲染成可点链接，点击经 opener 插件在系统浏览器打开。
 * 简介、评论等正文使用；不解析 Markdown，只做最小链接化。
 *
 * 链接字符限定 ASCII 可打印区：中文句子没有空格，靠字符集而不是空白符
 * 截断，`看https://b23.tv/xx这里` 也能正确切出链接。裸域名（无协议）仅在
 * 带路径时匹配，`img.png` 这类文件名不会被当成链接；尾随的中西文断句
 * 标点归还正文。
 */
const LINK_SPLIT = /(\b(?:https?:\/\/|www\.)[!-~]+|\b(?:[\w-]+\.)+[a-z]{2,}\/[!-~]*)/i;
/** 句尾紧跟链接的断句标点不属于链接本身（如 `看b23.tv/xx。` 的句号）。 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** 链接化结果片段：一段正文，或一个链接（裸域名补上 https 前缀）。 */
export type TextLinkSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly link: string; readonly href: string };

function linkHref(link: string): string {
  return /^https?:\/\//i.test(link) ? link : `https://${link}`;
}

/** 正文按 URL 切片；无链接时返回单段正文，调用方保持零额外 DOM。 */
export function linkifySegments(text: string): readonly TextLinkSegment[] {
  // split 带一个捕获组：奇数段是链接，偶数段是链接之间的正文。
  const pieces = text.split(LINK_SPLIT);
  if (pieces.length === 1) return [{ kind: "text", text }];
  const segments: TextLinkSegment[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (index % 2 === 0) {
      if (piece) segments.push({ kind: "text", text: piece });
      continue;
    }
    const link = piece.replace(TRAILING_PUNCTUATION, "");
    const tail = piece.slice(link.length);
    if (!link) {
      if (piece) segments.push({ kind: "text", text: piece });
      continue;
    }
    segments.push({ kind: "link", link, href: linkHref(link) });
    if (tail) segments.push({ kind: "text", text: tail });
  }
  return segments;
}

export function LinkText({ text }: { text: string }): ReactNode {
  const segments = linkifySegments(text);
  if (segments.length === 1 && segments[0].kind === "text") return text;
  return segments.map((segment, index) =>
    segment.kind === "text" ? (
      segment.text
    ) : (
      <a
        key={index}
        href={segment.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80"
        onClick={(event) => {
          event.preventDefault();
          // 评论整行常是打开详情的按钮，链接点击不能连带触发。
          event.stopPropagation();
          void openExternalUrl(segment.href).then((opened) => {
            // opener 与 window.open 双双失败（弹窗被拦等）时点击会毫无反应，
            // 用 toast 兜底告知。
            if (!opened) notify.error("打开链接失败", segment.href);
          });
        }}
      >
        {segment.link}
      </a>
    ),
  );
}
