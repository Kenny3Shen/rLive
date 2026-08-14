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
  /** Stable local identifier; never sent to an upstream service. */
  id: string;
  /** The Unicode text inserted into the Bilibili draft when selected. */
  text: string;
  label: string;
  src: string;
  /** Common Bilibili text aliases rendered with the same local artwork. */
  aliases?: readonly string[];
};

/**
 * A deliberately small, local fallback palette for incoming plain-text
 * messages. It avoids importing/rehosting platform-owned emote packs while
 * still rendering portable Unicode and common Bilibili-style aliases.
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
 * Bilibili Live's built-in text faces from its web client's `EMOJI_LIST`.
 * These are ordinary danmaku text, so selecting one does not rely on a
 * platform-owned image pack or a user-specific emote entitlement.
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

// Longest first matters for future aliases that share a prefix.
const emojiTokens = [...emojiByToken.keys()].sort((left, right) => right.length - left.length);

/** Split only the known, local emoji tokens; all remaining text stays text. */
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

/** Safe text renderer for the right-side message lists; it never parses HTML. */
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
 * Renders protocol-provided Bilibili image emotes when the backend supplied
 * validated rich spans. Plain text continues through the local emoji renderer
 * so every supported site keeps the same lightweight fallback behaviour.
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
