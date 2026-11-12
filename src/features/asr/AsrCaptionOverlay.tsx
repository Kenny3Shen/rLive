import type { CSSProperties, RefObject } from "react";
import { AppWindow, ArrowRight } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { glassOptionClass, glassPanelClass } from "@/shared/components/player/glassSurface";
import { cn } from "@/lib/utils";
import {
  TRANSLATION_LANGUAGE_OPTIONS,
  TRANSLATION_SOURCE_LANGUAGE_OPTIONS,
} from "@/shared/translation/languages";
import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
} from "@/shared/types/live";
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
 * 传入 `onOpenWindow` 时轨道右下角出现「在独立窗口显示字幕」按钮。字幕翻译开启时，
 * 框上方还显示语言选择；按钮和语言选择接收指针，字幕正文仍然点击穿透到画面。
 *
 * 按钮钉在只随画面尺寸变化的轨道右下角，不跟着字幕长短或有无切换位置。
 *
 * 轨道宽度跟随视频画面而不是播放器：`object-contain` 的画面在播放器里会留黑边，
 * 竖屏流尤其窄。外层铺满播放器并声明 `container-type: size`，画面宽即
 * `min(100cqw, 100cqh × 画幅)`，轨道取它的 92%，同时不超出左右 1rem 留边；
 * 画幅未知（首帧前）时按播放器宽度计。
 * 字幕背景固定容量，不随文字伸缩：不翻译最多 3 行，翻译最多 5 行。容量按设置字号
 * 推算，同时受当前画面在控制栏、语言栏和顶部呼吸区之外的剩余高度约束，小窗口会
 * 自动缩小，大窗口恢复完整容量。文字贴底排布，超出时裁掉最早的行。
 * 窗口按钮只在直播间路径出现，只为字幕框让出 `3.5rem` 横向空间，不参与高度分档。
 */
export function AsrCaptionOverlay({
  asr,
  fontSize,
  translationFrom = "auto",
  translationTo,
  onTranslationFromChange,
  onTranslationToChange,
  portalContainer,
  className,
  vodResizeAnchor = false,
  onOpenWindow,
  translationActive = false,
  videoAspectRatio = null,
}: {
  asr: AsrCaptionOverlayState;
  fontSize: number;
  translationFrom?: CaptionTranslationSourceLanguage;
  translationTo: CaptionTranslationLanguage;
  onTranslationFromChange?: (from: CaptionTranslationSourceLanguage) => void;
  onTranslationToChange?: (to: CaptionTranslationLanguage) => void;
  /** 全屏时舞台进入 top layer，语言菜单也必须 portal 进同一个容器。 */
  portalContainer?: HTMLElement | RefObject<HTMLElement | null> | null;
  className?: string;
  /** 点播拖动期单独平移字幕，不跟随视频表面缩放。 */
  vodResizeAnchor?: boolean;
  /** 直播间专用：打开保留整场对话的独立字幕窗口。 */
  onOpenWindow?: () => void;
  /** 字幕翻译开启时显示语言行，并把字幕容量扩到 5 行。 */
  translationActive?: boolean;
  /** 当前视频画幅（宽 / 高）；轨道宽高按实际画面而不是整个舞台计算。 */
  videoAspectRatio?: number | null;
}) {
  const { caption, partial, translatedCaption, translationNotice } = useAsrCaptionText(asr.text);
  const hasContent = asr.notice || caption || translatedCaption || translationNotice || partial;
  // 背景容量按行数推算：行高 1.625em，上下内边距合计 0.75rem。
  // 不翻译：定稿 2 行 + 在途 1 行，1 处 span 间距（gap-0.5 = 0.125rem）；
  // 翻译：再加译文 2 行，共 2 处间距。
  const captionCapacityHeight = translationActive
    ? "calc(5 * 1.625em + 0.75rem + 2 * 0.125rem)"
    : "calc(3 * 1.625em + 0.75rem + 0.125rem)";
  // 只有字幕开启时才提供独立窗口入口；这样 12 秒过期、等待下一句的空档里
  // 按钮仍然留在原位，而不是跟着叠加层一起消失。
  const showWindowButton = onOpenWindow && asr.captionsOn;
  // 翻译开启时，把源语言和目标语言放在字幕框紧邻的上方。空档仍显示这一行，
  // 方便用户直接调整语言；下方的透明占位避免正文卸载后控件向下跳动。
  const showTranslationLanguages = translationActive && asr.captionsOn;
  const showOverlay =
    (asr.captionsOn || asr.notice) &&
    (hasContent || showWindowButton || showTranslationLanguages);
  if (!showOverlay) return null;

  const captionSurfaceClass =
    "flex h-full w-full min-w-0 flex-col justify-end overflow-hidden rounded-md bg-black/78 px-3 py-1.5 text-center leading-relaxed font-medium text-white shadow-md [text-shadow:0_1px_2px_rgb(0_0_0_/_0.9)]";
  const captionBox = (
    <p
      className={cn(
        captionSurfaceClass,
        asr.noticeIsError && asr.notice && "border border-destructive/45 text-red-100",
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
  const emptyCaptionBox = (
    <div
      aria-hidden
      data-slot="asr-caption-empty-space"
      className={cn(captionSurfaceClass, "invisible min-h-0 shrink")}
      style={{ fontSize: `${fontSize}px`, height: captionCapacityHeight }}
    />
  );
  const translationLanguages = showTranslationLanguages ? (
    <div
      data-slot="asr-caption-translation-languages"
      data-player-controls
      className="pointer-events-auto flex w-full min-w-0 shrink-0 items-center"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-white/10 bg-black/78 p-1 text-white shadow-md @min-[14rem]/asr-caption:gap-1.5 @min-[14rem]/asr-caption:p-1.5">
        <Select
          items={TRANSLATION_SOURCE_LANGUAGE_OPTIONS}
          value={translationFrom}
          onValueChange={(value) => value && onTranslationFromChange?.(value)}
        >
          <SelectTrigger
            aria-label="原文语言"
            size="sm"
            glass
            disabled={!onTranslationFromChange}
            className="h-8 min-w-0 flex-1 justify-between px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80 @min-[14rem]/asr-caption:px-2.5"
          >
            <SelectValue className="min-w-0 truncate" />
          </SelectTrigger>
          <SelectContent
            container={portalContainer}
            side="top"
            align="start"
            glass
            data-player-controls
            className={glassPanelClass({ overlay: true })}
          >
            <SelectGroup>
              {TRANSLATION_SOURCE_LANGUAGE_OPTIONS.map((language) => (
                <SelectItem
                  key={language.value}
                  value={language.value}
                  glass
                  className={glassOptionClass()}
                >
                  {language.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <ArrowRight
          className="size-4 shrink-0 text-white/55 @max-[7.5rem]/asr-caption:hidden"
          aria-hidden
        />
        <Select
          items={TRANSLATION_LANGUAGE_OPTIONS}
          value={translationTo}
          onValueChange={(value) => value && onTranslationToChange?.(value)}
        >
          <SelectTrigger
            aria-label="译文语言"
            size="sm"
            glass
            disabled={!onTranslationToChange}
            className="h-8 min-w-0 flex-1 justify-between px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80 @min-[14rem]/asr-caption:px-2.5"
          >
            <SelectValue className="min-w-0 truncate" />
          </SelectTrigger>
          <SelectContent
            container={portalContainer}
            side="top"
            align="end"
            glass
            data-player-controls
            className={glassPanelClass({ overlay: true })}
          >
            <SelectGroup>
              {TRANSLATION_LANGUAGE_OPTIONS.map((language) => (
                <SelectItem
                  key={language.value}
                  value={language.value}
                  glass
                  className={glassOptionClass()}
                >
                  {language.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </div>
  ) : null;

  const aspectRatio =
    videoAspectRatio != null && Number.isFinite(videoAspectRatio) && videoAspectRatio > 0
      ? videoAspectRatio
      : null;
  // 轨道取画面宽的 92%；画幅未知时就是播放器宽的 92%，已知时按 contain 后的实际画幅收窄。
  const trackWidth = aspectRatio
    ? `min(92cqw, ${(aspectRatio * 92).toFixed(4)}cqh)`
    : "92cqw";
  const pictureHeight = aspectRatio
    ? `min(100cqh, ${(100 / aspectRatio).toFixed(4)}cqw)`
    : "100cqh";
  const trackStyle = {
    width: trackWidth,
    "--asr-picture-height": pictureHeight,
  } as CSSProperties;

  return (
    // 铺满播放器的尺寸容器，只给轨道提供 cq 单位；本身不拦截指针。
    <div className="pointer-events-none absolute inset-0 z-20 [container-type:size]">
      <div
        data-vod-details-resize-anchor={vodResizeAnchor ? "true" : undefined}
        className={cn(
          "pointer-events-none absolute inset-x-4 top-4 bottom-[4.5rem] flex justify-center",
          className,
        )}
      >
        {/* 轨道只随画面尺寸改宽高，不随文字伸缩。 */}
        <div
          className="relative flex h-full min-h-0 max-w-full items-end justify-center"
          style={trackStyle}
        >
          {/* 语言栏先占高度，正文容量再缩到其余可用空间；空占位与正文完全同宽同高。 */}
          <div
            className={cn(
              "flex min-h-0 max-w-full flex-col justify-end gap-1.5 @container/asr-caption",
              showWindowButton ? "w-[calc(100%-3.5rem)]" : "w-full",
            )}
            style={{ maxHeight: "min(100%, var(--asr-picture-height))" }}
          >
            {translationLanguages}
            {hasContent ? (
              // live region 只包字幕文字，语言控件和窗口按钮不会被重复播报。
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="flex min-h-0 w-full shrink justify-center"
                style={{ fontSize: `${fontSize}px`, height: captionCapacityHeight }}
              >
                {captionBox}
              </div>
            ) : (
              emptyCaptionBox
            )}
          </div>
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
