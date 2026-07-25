import { cn } from "@/lib/utils";
import clapSrc from "@/assets/danmaku-emoji/clap.svg";
import dogeSrc from "@/assets/danmaku-emoji/doge.svg";
import heartSrc from "@/assets/danmaku-emoji/heart.svg";
import laughSrc from "@/assets/danmaku-emoji/laugh.svg";
import likeSrc from "@/assets/danmaku-emoji/like.svg";
import partySrc from "@/assets/danmaku-emoji/party.svg";
import smileSrc from "@/assets/danmaku-emoji/smile.svg";
import wowSrc from "@/assets/danmaku-emoji/wow.svg";

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
 * A deliberately small, local palette. It keeps the composer usable offline
 * and avoids importing/rehosting platform-owned emote packs. The Unicode text
 * is portable across the supported chat protocols; Bilibili-style aliases are
 * display-only fallbacks for incoming plain-text messages.
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
              "mx-px inline-block size-[1.25em] select-none align-[-0.22em] object-contain",
              emojiClassName,
            )}
          />
        ),
      )}
    </span>
  );
}
