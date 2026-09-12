import { cn } from "@/lib/utils";
import type { CaptionTranslationLanguage } from "@/shared/types/live";
import type { AsrCaptions } from "./useAsrCaptions";

/** 叠加层只读这几项；`AsrCaptions` 的其余字段属于控件契约。 */
export type AsrCaptionOverlayState = Pick<
  AsrCaptions,
  | "captionsOn"
  | "caption"
  | "translatedCaption"
  | "partial"
  | "notice"
  | "translationNotice"
  | "noticeIsError"
>;

/**
 * 语音字幕叠加层：直播间、IPTV、多画面与点播共用同一块画面内字幕。
 *
 * 底部锚点由调用方给（`className`）：控制栏是否为系统手势栏预留由各播放页自己
 * 判定（见 `docs/zh/播放器技术文档.md` 第 7 节），叠加层必须跟着同一份判定。
 * 「这一屏该不该有字幕」（加载态、仅音频）同样归调用方；本组件只判有没有内容。
 */
export function AsrCaptionOverlay({
  asr,
  fontSize,
  translationTo,
  className,
}: {
  asr: AsrCaptionOverlayState;
  fontSize: number;
  translationTo: CaptionTranslationLanguage;
  className?: string;
}) {
  const hasContent =
    asr.notice || asr.caption || asr.translatedCaption || asr.translationNotice || asr.partial;
  if (!(asr.captionsOn || asr.notice) || !hasContent) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "pointer-events-none absolute inset-x-4 bottom-[4.5rem] z-20 flex justify-center",
        className,
      )}
    >
      <p
        className={cn(
          "flex max-h-[min(7em,45dvh)] min-w-0 max-w-[min(48rem,92%)] flex-col justify-end overflow-hidden rounded-md bg-black/78 px-3 py-1.5 text-center leading-relaxed font-medium text-white shadow-md [text-shadow:0_1px_2px_rgb(0_0_0_/_0.9)]",
          asr.noticeIsError && asr.notice && "border border-destructive/45 text-red-100",
        )}
        style={{ fontSize: `${fontSize}px` }}
      >
        {asr.notice ?? (
          <span className="flex shrink-0 flex-col gap-0.5 whitespace-pre-line break-words">
            {asr.caption ? <span>{asr.caption}</span> : null}
            {asr.translatedCaption ? (
              <span
                lang={translationTo === "auto" ? undefined : translationTo}
                className="text-white/82"
              >
                {asr.translatedCaption}
              </span>
            ) : null}
            {asr.translationNotice ? (
              <span className="text-xs font-normal text-destructive">{asr.translationNotice}</span>
            ) : null}
            {asr.partial ? <span className="text-white/60">{asr.partial}</span> : null}
          </span>
        )}
      </p>
    </div>
  );
}
