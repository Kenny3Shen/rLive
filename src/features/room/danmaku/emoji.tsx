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
  DANMAKU_IMAGE_FALLBACK_TEXT,
  DANMAKU_IMAGE_SCALE,
  danmakuImageRequestUrl,
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

/**
 * 当后端提供已校验的富片段时渲染平台下发的 Bilibili 图片表情。
 * text 片段原样输出；调用方保证只有携带图片片段的消息才进入本组件。
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
    return <span className={className}>{content}</span>;
  }

  return (
    <span className={className}>
      {richContent.map((span, index) =>
        span.type === "text" ? (
          <span key={`text-${index}`}>{span.text}</span>
        ) : (
          <img
            key={`image-${span.image_url}-${index}`}
            src={danmakuImageRequestUrl(span.image_url)}
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
            onError={(event) => {
              const image = event.currentTarget;
              // 与悬浮层一致：代理失败先回退直连 CDN，再失败才替换为占位文本。
              if (!image.src.startsWith("http")) {
                image.src = span.image_url;
                return;
              }
              image.replaceWith(document.createTextNode(DANMAKU_IMAGE_FALLBACK_TEXT));
            }}
          />
        ),
      )}
    </span>
  );
}
