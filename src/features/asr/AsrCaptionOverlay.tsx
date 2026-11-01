import { AppWindow } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CaptionTranslationLanguage } from "@/shared/types/live";
import { useAsrCaptionText } from "./asrCaptionText";
import type { AsrCaptions } from "./useAsrCaptions";

/** 叠加层只读这几项；`AsrCaptions` 的其余字段属于控件契约。 */
export type AsrCaptionOverlayState = Pick<
  AsrCaptions,
  "captionsOn" | "text" | "notice" | "noticeIsError"
>;

/**
 * 语音字幕叠加层：直播间、IPTV、多画面与点播共用同一块画面内字幕。
 *
 * 底部锚点由调用方给（`className`）：控制栏是否为系统手势栏预留由各播放页自己
 * 判定（见 `docs/zh/播放器技术文档.md` 第 7 节），叠加层必须跟着同一份判定。
 * 「这一屏该不该有字幕」（加载态、仅音频）同样归调用方；本组件只判有没有内容。
 *
 * 字幕文本在这里订阅（`asr.text`），随识别窗更新的只有本组件，宿主播放页不重渲染。
 *
 * 传入 `onOpenWindow` 时轨道右下角出现「在独立窗口显示字幕」按钮；只有这个按钮
 * 接收指针，字幕本身仍然点击穿透到画面。
 *
 * 按钮不能钉在字幕框上：框宽高随每句文字变化，12 秒无字幕后叠加层还会整体卸载。
 * 因此直播间路径先铺一条只随播放器尺寸变化的固定宽度轨道，按钮绝对定位在轨道右下角。
 * 字幕背景同样固定尺寸，不随文字伸缩：宽为「轨道宽度 − 3.5rem」（居中后左右各留
 * 1.75rem，恰好等于按钮宽度 `size-7`），高恒为原来的上限 `min(7em,45dvh)`，按字号
 * 缩放；文字在框内贴底排布，超出时裁掉最早的行，最新一句始终可见。
 */
export function AsrCaptionOverlay({
  asr,
  fontSize,
  translationTo,
  className,
  vodResizeAnchor = false,
  onOpenWindow,
}: {
  asr: AsrCaptionOverlayState;
  fontSize: number;
  translationTo: CaptionTranslationLanguage;
  className?: string;
  /** 点播拖动期单独平移字幕，不跟随视频表面缩放。 */
  vodResizeAnchor?: boolean;
  /** 直播间专用：打开保留整场对话的独立字幕窗口。 */
  onOpenWindow?: () => void;
}) {
  const { caption, partial, translatedCaption, translationNotice } = useAsrCaptionText(asr.text);
  const hasContent = asr.notice || caption || translatedCaption || translationNotice || partial;
  // 只有字幕开启时才提供独立窗口入口；这样 12 秒过期、等待下一句的空档里
  // 按钮仍然留在原位，而不是跟着叠加层一起消失。
  const showWindowButton = onOpenWindow && asr.captionsOn;
  // 直播间路径用固定尺寸背景并给右下角按钮让出 3.5rem；其他宿主没有按钮，
  // 背景仍随文字伸缩（`max-w-full` + `max-h`）。
  const captionBox = (
    <p
      className={cn(
        "flex max-h-[min(7em,45dvh)] min-w-0 max-w-full flex-col justify-end overflow-hidden rounded-md bg-black/78 px-3 py-1.5 text-center leading-relaxed font-medium text-white shadow-md [text-shadow:0_1px_2px_rgb(0_0_0_/_0.9)]",
        asr.noticeIsError && asr.notice && "border border-destructive/45 text-red-100",
        onOpenWindow && "h-[min(7em,45dvh)] w-[calc(100%-3.5rem)] max-w-[calc(100%-3.5rem)]",
      )}
      style={{ fontSize: `${fontSize}px` }}
    >
      {asr.notice ?? (
        <span className="flex shrink-0 flex-col gap-0.5 whitespace-pre-line break-words">
          {caption ? <span>{caption}</span> : null}
          {translatedCaption ? (
            <span
              lang={translationTo === "auto" ? undefined : translationTo}
              className="text-white/82"
            >
              {translatedCaption}
            </span>
          ) : null}
          {translationNotice ? (
            <span className="text-xs font-normal text-destructive">{translationNotice}</span>
          ) : null}
          {partial ? <span className="text-white/60">{partial}</span> : null}
        </span>
      )}
    </p>
  );

  if (!onOpenWindow) {
    // 非直播间宿主保持原有结构与视觉：没有内容就整体不渲染。
    if (!(asr.captionsOn || asr.notice) || !hasContent) return null;
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-vod-details-resize-anchor={vodResizeAnchor ? "true" : undefined}
        className={cn(
          "pointer-events-none absolute inset-x-4 bottom-[4.5rem] z-20 flex justify-center",
          className,
        )}
      >
        <div className="relative min-w-0 max-w-[min(48rem,92%)]">{captionBox}</div>
      </div>
    );
  }

  // 字幕开启但没有内容时只保留轨道与按钮，不渲染空字幕框。
  if (!(asr.captionsOn || asr.notice) || (!hasContent && !showWindowButton)) return null;

  return (
    <div
      data-vod-details-resize-anchor={vodResizeAnchor ? "true" : undefined}
      className={cn(
        "pointer-events-none absolute inset-x-4 bottom-[4.5rem] z-20 flex justify-center",
        className,
      )}
    >
      {/* 固定宽度轨道：只有播放器尺寸变化时才改宽。 */}
      <div className="relative flex w-[min(48rem,92%)] justify-center">
        {hasContent ? (
          // live region 只包字幕文字，按钮在外层，不会被重复播报。
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="flex w-full min-w-0 justify-center"
          >
            {captionBox}
          </div>
        ) : null}
        {showWindowButton ? (
          <button
            type="button"
            aria-label="在独立窗口显示字幕"
            title="在独立窗口显示字幕"
            className="pointer-events-auto absolute right-0 bottom-0 inline-flex size-7 items-center justify-center rounded-sm bg-black/60 text-white/85 transition-colors hover:bg-black/80 hover:text-white focus-visible:outline-2 focus-visible:outline-white/80"
            onClick={onOpenWindow}
          >
            <AppWindow className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
