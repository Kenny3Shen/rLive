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
 * 因此直播间路径先铺一条只随画面尺寸变化的轨道，按钮绝对定位在轨道右下角。
 *
 * 轨道宽度跟随视频画面而不是播放器：`object-contain` 的画面在播放器里会留黑边，
 * 竖屏流尤其窄。外层铺满播放器并声明 `container-type: size`，画面宽即
 * `min(100cqw, 100cqh × 画幅)`，轨道取它的 92%，同时不超出左右 1rem 留边；
 * 画幅未知（首帧前）时按播放器宽度计。
 * 字幕背景同样固定尺寸，不随文字伸缩：宽为「轨道宽度 − 3.5rem」（居中后左右各留
 * 1.75rem，恰好等于按钮宽度 `size-7`）；高按是否显示译文分两档（`translationActive`），
 * 因为不翻译时只有定稿 2 行 + 在途 1 行，留出译文的空间会显空，而翻译时又多出译文
 * 2 行。两档都按 `leading-relaxed` 的 1.625em 行高加 `py-1.5` 推算，并以 45dvh 封顶；
 * 文字在框内贴底排布，超出时裁掉最早的行，最新一句始终可见。
 */
export function AsrCaptionOverlay({
  asr,
  fontSize,
  translationTo,
  className,
  vodResizeAnchor = false,
  onOpenWindow,
  translationActive = false,
  videoAspectRatio = null,
}: {
  asr: AsrCaptionOverlayState;
  fontSize: number;
  translationTo: CaptionTranslationLanguage;
  className?: string;
  /** 点播拖动期单独平移字幕，不跟随视频表面缩放。 */
  vodResizeAnchor?: boolean;
  /** 直播间专用：打开保留整场对话的独立字幕窗口。 */
  onOpenWindow?: () => void;
  /** 直播间固定尺寸背景按是否显示译文选择高度；其他宿主不受影响。 */
  translationActive?: boolean;
  /** 直播间：视频画幅（宽 / 高），轨道宽度按画面而不是播放器计算。 */
  videoAspectRatio?: number | null;
}) {
  const { caption, partial, translatedCaption, translationNotice } = useAsrCaptionText(asr.text);
  const hasContent = asr.notice || caption || translatedCaption || translationNotice || partial;
  // 直播间背景高度按行数推算：行高 1.625em，上下内边距合计 0.75rem。
  // 不翻译：定稿 2 行 + 在途 1 行，1 处 span 间距（gap-0.5 = 0.125rem）；
  // 翻译：再加译文 2 行，共 2 处间距。
  const fixedCaptionHeight = onOpenWindow
    ? translationActive
      ? "min(calc(5 * 1.625em + 0.75rem + 2 * 0.125rem), 45dvh)"
      : "min(calc(3 * 1.625em + 0.75rem + 0.125rem), 45dvh)"
    : undefined;
  // 只有字幕开启时才提供独立窗口入口；这样 12 秒过期、等待下一句的空档里
  // 按钮仍然留在原位，而不是跟着叠加层一起消失。
  const showWindowButton = onOpenWindow && asr.captionsOn;
  // 直播间路径用固定尺寸背景并给右下角按钮让出 3.5rem；其他宿主没有按钮，
  // 背景仍随文字伸缩（`max-w-full` + `max-h`）。
  const captionBox = (
    <p
      className={cn(
        "flex min-w-0 max-w-full flex-col justify-end overflow-hidden rounded-md bg-black/78 px-3 py-1.5 text-center leading-relaxed font-medium text-white shadow-md [text-shadow:0_1px_2px_rgb(0_0_0_/_0.9)]",
        asr.noticeIsError && asr.notice && "border border-destructive/45 text-red-100",
        // 直播间用内联高度，避免与 max-h 上限打架；其他宿主仍靠 max-h 随文字伸缩。
        onOpenWindow ? "w-[calc(100%-3.5rem)] max-w-[calc(100%-3.5rem)]" : "max-h-[min(7em,45dvh)]",
      )}
      style={{ fontSize: `${fontSize}px`, height: fixedCaptionHeight }}
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

  const aspectRatio =
    videoAspectRatio != null && Number.isFinite(videoAspectRatio) && videoAspectRatio > 0
      ? videoAspectRatio
      : null;
  // 画面宽：画幅未知时就是播放器宽；已知时取 `object-contain` 实际铺开的宽度。
  const pictureWidth = aspectRatio ? `min(100cqw, ${aspectRatio.toFixed(4)} * 100cqh)` : "100cqw";

  return (
    // 铺满播放器的尺寸容器，只给轨道提供 cq 单位；本身不拦截指针。
    <div className="pointer-events-none absolute inset-0 z-20 [container-type:size]">
      <div
        data-vod-details-resize-anchor={vodResizeAnchor ? "true" : undefined}
        className={cn(
          "pointer-events-none absolute inset-x-4 bottom-[4.5rem] flex justify-center",
          className,
        )}
      >
        {/* 轨道只随画面尺寸改宽，不随文字伸缩。 */}
        <div
          className="relative flex max-w-full justify-center"
          style={{ width: `calc(${pictureWidth} * 0.92)` }}
        >
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
    </div>
  );
}
