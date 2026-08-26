import { cn } from "@/lib/utils";
import clapSrc from "@/assets/danmaku-emoji/clap.svg";
import dogeSrc from "@/assets/danmaku-emoji/doge.svg";
import heartSrc from "@/assets/danmaku-emoji/heart.svg";
import laughSrc from "@/assets/danmaku-emoji/laugh.svg";
import likeSrc from "@/assets/danmaku-emoji/like.svg";
import partySrc from "@/assets/danmaku-emoji/party.svg";
import smileSrc from "@/assets/danmaku-emoji/smile.svg";
import wowSrc from "@/assets/danmaku-emoji/wow.svg";
import {
  BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY,
  DANMAKU_IMAGE_SCALE,
  richDanmakuContent,
} from "./content";

export type DanmakuEmoji = {
  /** 稳定的本地标识符；绝不发送给上游服务。 */
  id: string;
  /** 选中时插入 Bilibili 草稿的 Unicode 文本。 */
  text: string;
  label: string;
  src: string;
  /** 使用同一套本地素材渲染的常见 Bilibili 文本别名。 */
  aliases?: readonly string[];
};

/**
 * 为到达的纯文本消息准备的刻意精简的本地兜底表情表。它避免导入或转存平台
 * 所有的表情包，
 * 同时仍能渲染通用 Unicode 和常见 Bilibili 风格别名。
 */
export const DANMAKU_EMOJIS: readonly DanmakuEmoji[] = [
  { id: "smile", text: "😀", label: "微笑", src: smileSrc, aliases: ["[微笑]"] },
  { id: "laugh", text: "😆", label: "笑哭", src: laughSrc, aliases: ["[笑哭]", "[哈哈]"] },
  { id: "heart", text: "❤️", label: "爱心", src: heartSrc, aliases: ["[爱心]"] },
  { id: "like", text: "👍", label: "点赞", src: likeSrc, aliases: ["[点赞]"] },
  { id: "wow", text: "😮", label: "惊讶", src: wowSrc, aliases: ["[惊讶]"] },
  { id: "party", text: "🎉", label: "庆祝", src: partySrc, aliases: ["[庆祝]"] },
  { id: "clap", text: "👏", label: "鼓掌", src: clapSrc, aliases: ["[鼓掌]"] },
  { id: "doge", text: "🐶", label: "Doge", src: dogeSrc, aliases: ["[doge]"] },
];

/**
 * Bilibili 直播 Web 客户端 `EMOJI_LIST` 中的内置文字颜文字。它们是普通的弹幕
 * 文本，选择它们不依赖平台所有的图片包或用户专属的表情权益。
 */
export const BILIBILI_NATIVE_TEXT_EMOJIS = [
  "(⌒▽⌒)",
  "（￣▽￣）",
  "(=・ω・=)",
  "(｀・ω・´)",
  "(〜￣△￣)〜",
  "(･∀･)",
  "(°∀°)ﾉ",
  "(￣3￣)",
  "╮(￣▽￣)╭",
  "_(:3」∠)_",
  "( ´_ゝ｀)",
  "←_←",
  "→_→",
  "(<_<)",
  "(>_>)",
  "(;¬_¬)",
  '("▔□▔)/',
  "(ﾟДﾟ≡ﾟдﾟ)!?",
  "Σ(ﾟдﾟ;)",
  "Σ( ￣□￣||)",
  "(´；ω；`)",
  "（/TДT)/",
  "(^・ω・^ )",
  "(｡･ω･｡)",
  "(●￣(ｴ)￣●)",
  "ε=ε=(ノ≧∇≦)ノ",
  "(´･_･`)",
  "(-_-#)",
  "（￣へ￣）",
  "(￣ε(#￣) Σ",
  "ヽ(`Д´)ﾉ",
  "（#-_-)┯━┯",
  "(╯°口°)╯(┴—┴",
  "←◡←",
  "( ♥д♥)",
  "Σ>―(〃°ω°〃)♡→",
  "⁄(⁄ ⁄•⁄ω⁄•⁄ ⁄)⁄",
  "(╬ﾟдﾟ)▄︻┻┳═一",
  "･*･:≡(　ε:)",
  "(汗)",
  "(苦笑)",
] as const;

export type DanmakuContentSegment =
  | { type: "text"; value: string }
  | { type: "emoji"; value: DanmakuEmoji };

const emojiByToken = new Map<string, DanmakuEmoji>();
for (const emoji of DANMAKU_EMOJIS) {
  emojiByToken.set(emoji.text, emoji);
  for (const alias of emoji.aliases ?? []) emojiByToken.set(alias, emoji);
}

// 最长的优先，为将来共享前缀的别名做准备。
const emojiTokens = [...emojiByToken.keys()].sort((left, right) => right.length - left.length);

/** 只拆分已知、本地的 emoji 记号；其余文本保持原样。 */
export function tokenizeDanmakuContent(content: string): DanmakuContentSegment[] {
  if (!content) return [];

  const segments: DanmakuContentSegment[] = [];
  let textStart = 0;
  let index = 0;

  while (index < content.length) {
    const token = emojiTokens.find((candidate) => content.startsWith(candidate, index));
    if (!token) {
      index += 1;
      continue;
    }

    if (textStart < index) {
      segments.push({ type: "text", value: content.slice(textStart, index) });
    }
    const emoji = emojiByToken.get(token);
    if (emoji) segments.push({ type: "emoji", value: emoji });
    index += token.length;
    textStart = index;
  }

  if (textStart < content.length) {
    segments.push({ type: "text", value: content.slice(textStart) });
  }
  return segments;
}

/** 右侧消息列表的安全文本渲染器；绝不解析 HTML。 */
export function DanmakuEmojiText({
  content,
  className,
  emojiClassName,
}: {
  content: string;
  className?: string;
  emojiClassName?: string;
}) {
  const segments = tokenizeDanmakuContent(content);
  if (segments.length === 0) return null;

  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          <span key={`text-${index}`}>{segment.value}</span>
        ) : (
          <img
            key={`emoji-${segment.value.id}-${index}`}
            src={segment.value.src}
            alt={segment.value.label}
            draggable={false}
            className={cn(
              "mx-px inline-block select-none align-[-0.25em] object-contain",
              emojiClassName,
            )}
            style={{
              width: `${DANMAKU_IMAGE_SCALE}em`,
              height: `${DANMAKU_IMAGE_SCALE}em`,
            }}
          />
        ),
      )}
    </span>
  );
}

/**
 * 当后端提供已校验的富片段时渲染平台下发的 Bilibili 图片表情。纯文本继续走
 * 本地表情渲染器，使每个受支持的站点保持同样轻量的兜底行为。
 */
export function DanmakuRichText({
  content,
  spans,
  className,
  emojiClassName,
}: {
  content: string;
  spans?: unknown;
  className?: string;
  emojiClassName?: string;
}) {
  const richContent = richDanmakuContent(spans);
  if (!richContent) {
    return (
      <DanmakuEmojiText content={content} className={className} emojiClassName={emojiClassName} />
    );
  }

  return (
    <span className={className}>
      {richContent.map((span, index) =>
        span.type === "text" ? (
          <DanmakuEmojiText key={`text-${index}`} content={span.text} />
        ) : (
          <img
            key={`image-${span.image_url}-${index}`}
            src={span.image_url}
            alt="表情"
            draggable={false}
            referrerPolicy={BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY}
            className={cn(
              "mx-px inline-block select-none align-[-0.25em] object-contain",
              emojiClassName,
            )}
            style={{
              width: `${DANMAKU_IMAGE_SCALE}em`,
              height: `${DANMAKU_IMAGE_SCALE}em`,
            }}
          />
        ),
      )}
    </span>
  );
}
