import {
  useId,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { AppWindow, ArrowRight, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
 * 字幕开启后，顶栏与正文共用同一个背景。顶栏左侧依次调整源语言、目标语言、
 * 仅翻译和字号；右侧开启翻译、打开独立窗口并关闭字幕。顶栏接收指针，正文仍然
 * 点击穿透到画面。独立窗口按钮固定在顶栏右侧，不跟字幕长短移动。
 *
 * 轨道宽度跟随视频画面而不是播放器：`object-contain` 的画面在播放器里会留黑边，
 * 竖屏流尤其窄。外层铺满播放器并声明 `container-type: size`，画面宽即
 * `min(100cqw, 100cqh × 画幅)`，轨道取它的 92%，同时不超出左右 1rem 留边；
 * 画幅未知（首帧前）时按播放器宽度计。
 * 字幕正文背景固定容量，不随文字伸缩：不翻译最多 3 行，翻译最多 5 行，仅翻译
 * 最多 2 行。容量按设置字号推算，同时受当前画面在控制栏、顶栏和顶部呼吸区之外的
 * 剩余高度约束，小窗口会自动缩小，大窗口恢复完整容量。文字贴底排布，超出时裁掉
 * 最早的行。
 */
export function AsrCaptionOverlay({
  asr,
  fontSize,
  translationOnly = false,
  translationFrom = "auto",
  translationTo,
  onTranslationFromChange,
  onTranslationToChange,
  onTranslationOnlyChange,
  onFontSizeChange,
  portalContainer,
  className,
  vodResizeAnchor = false,
  onOpenWindow,
  translationActive = false,
  onTranslationActiveChange,
  onClose,
  videoAspectRatio = null,
}: {
  asr: AsrCaptionOverlayState;
  fontSize: number;
  /** 翻译开启时只保留译文；关闭翻译时保留偏好但显示原文。 */
  translationOnly?: boolean;
  translationFrom?: CaptionTranslationSourceLanguage;
  translationTo: CaptionTranslationLanguage;
  onTranslationFromChange?: (from: CaptionTranslationSourceLanguage) => void;
  onTranslationToChange?: (to: CaptionTranslationLanguage) => void;
  onTranslationOnlyChange?: (enabled: boolean) => void;
  onFontSizeChange?: (fontSize: number) => void;
  /** 全屏时舞台进入 top layer，语言菜单也必须 portal 进同一个容器。 */
  portalContainer?: HTMLElement | RefObject<HTMLElement | null> | null;
  className?: string;
  /** 点播拖动期单独平移字幕，不跟随视频表面缩放。 */
  vodResizeAnchor?: boolean;
  /** 直播间专用：打开保留整场对话的独立字幕窗口。 */
  onOpenWindow?: () => void;
  /** 字幕翻译开关；关闭时保留语言与仅译文偏好。 */
  translationActive?: boolean;
  onTranslationActiveChange?: (enabled: boolean) => void;
  /** 与底部控制栏的字幕开关保持一致。 */
  onClose?: () => void;
  /** 当前视频画幅（宽 / 高）；轨道宽高按实际画面而不是整个舞台计算。 */
  videoAspectRatio?: number | null;
}) {
  const toolbarId = useId();
  const sourceLanguageId = `${toolbarId}-source-language`;
  const targetLanguageId = `${toolbarId}-target-language`;
  const translationId = `${toolbarId}-translation`;
  const { caption, partial, translatedCaption, translationNotice } = useAsrCaptionText(asr.text);
  const onlyTranslatedCaption = translationActive && translationOnly;
  const hasContent =
    asr.notice ||
    translationNotice ||
    (onlyTranslatedCaption ? translatedCaption : caption || translatedCaption || partial);
  // 背景容量按行数推算：行高 1.625em，上下内边距合计 0.75rem。
  // 不翻译：定稿 2 行 + 在途 1 行，1 处 span 间距（gap-0.5 = 0.125rem）；
  // 翻译：再加译文 2 行，共 2 处间距。
  const captionCapacityHeight = onlyTranslatedCaption
    ? "calc(2 * 1.625em + 0.75rem)"
    : translationActive
      ? "calc(5 * 1.625em + 0.75rem + 2 * 0.125rem)"
      : "calc(3 * 1.625em + 0.75rem + 0.125rem)";
  const showToolbar = asr.captionsOn;
  const showOverlay = asr.captionsOn || asr.notice;
  if (!showOverlay) return null;

  const captionSurfaceClass =
    "flex h-full w-full min-w-0 flex-col justify-end px-3 py-1.5 text-center leading-relaxed font-medium text-white [text-shadow:0_1px_2px_rgb(0_0_0_/_0.9)]";
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
          {!onlyTranslatedCaption && caption ? <span>{caption}</span> : null}
          {translatedCaption ? (
            <span
              lang={translationTo === "auto" ? undefined : translationTo}
              className="text-white/82"
            >
              {translatedCaption}
            </span>
          ) : null}
          {translationNotice ? (
            <span className="text-sm font-normal text-destructive">{translationNotice}</span>
          ) : null}
          {!onlyTranslatedCaption && partial ? (
            <span className="text-white/60">{partial}</span>
          ) : null}
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
  const adjustFontSize = (delta: number) => {
    const next = Math.min(48, Math.max(12, Math.round(fontSize + delta)));
    if (next !== fontSize) onFontSizeChange?.(next);
  };
  const stopPlayerInteraction = {
    onPointerDown: (event: ReactPointerEvent) => event.stopPropagation(),
    onClick: (event: MouseEvent) => event.stopPropagation(),
    onDoubleClick: (event: MouseEvent) => event.stopPropagation(),
    onKeyDown: (event: ReactKeyboardEvent) => event.stopPropagation(),
  };
  const toolbar = showToolbar ? (
    <div
      data-slot="asr-caption-toolbar"
      data-player-controls
      className="pointer-events-auto flex w-full min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-white/10 px-2 py-2"
      {...stopPlayerInteraction}
    >
      <div className="flex min-w-0 flex-[1_1_26rem] flex-wrap items-center gap-2 text-white">
        <FieldGroup className="flex min-w-0 flex-[1_1_18rem] flex-row flex-wrap items-center gap-2">
          <Field
            orientation="horizontal"
            className="w-full min-w-0 gap-2 [&>[data-slot=field-label]]:flex-none @min-[30rem]/asr-caption:w-auto @min-[30rem]/asr-caption:flex-[1_1_10rem]"
          >
            <FieldLabel htmlFor={sourceLanguageId} className="text-white/72">
              源语言
            </FieldLabel>
            <Select
              items={TRANSLATION_SOURCE_LANGUAGE_OPTIONS}
              value={translationFrom}
              onValueChange={(value) => value && onTranslationFromChange?.(value)}
            >
              <SelectTrigger
                id={sourceLanguageId}
                size="sm"
                glass
                disabled={!onTranslationFromChange}
                className="h-8 w-auto min-w-0 flex-1 basis-0 justify-between border-white/15 bg-white/8 px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80 disabled:opacity-50"
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
          </Field>
          <ArrowRight
            className="size-4 shrink-0 text-white/45 @max-[30rem]/asr-caption:hidden"
            aria-hidden
          />
          <Field
            orientation="horizontal"
            className="w-full min-w-0 gap-2 [&>[data-slot=field-label]]:flex-none @min-[30rem]/asr-caption:w-auto @min-[30rem]/asr-caption:flex-[1_1_10rem]"
          >
            <FieldLabel htmlFor={targetLanguageId} className="text-white/72">
              目标语言
            </FieldLabel>
            <Select
              items={TRANSLATION_LANGUAGE_OPTIONS}
              value={translationTo}
              onValueChange={(value) => value && onTranslationToChange?.(value)}
            >
              <SelectTrigger
                id={targetLanguageId}
                size="sm"
                glass
                disabled={!onTranslationToChange}
                className="h-8 w-auto min-w-0 flex-1 basis-0 justify-between border-white/15 bg-white/8 px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80 disabled:opacity-50"
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
          </Field>
        </FieldGroup>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={onlyTranslatedCaption}
          title="只显示翻译文本"
          disabled={!translationActive || !onTranslationOnlyChange}
          className={cn(
            "h-8 text-white/80 hover:bg-white/12 hover:text-white disabled:text-white/35",
            onlyTranslatedCaption && "bg-white/15 text-white",
          )}
          onClick={() => onTranslationOnlyChange?.(!translationOnly)}
        >
          仅翻译
        </Button>
        <div
          role="group"
          className="flex shrink-0 items-center gap-1 text-sm"
          aria-label="字幕字号"
        >
          <span className="px-1 text-white/72">字号</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="减小字幕字号"
            disabled={!onFontSizeChange || fontSize <= 12}
            className="text-white/80 hover:bg-white/12 hover:text-white disabled:text-white/30"
            onClick={() => adjustFontSize(-2)}
          >
            <Minus data-icon="inline-start" aria-hidden />
          </Button>
          <span className="w-10 text-center tabular-nums text-white/85">{fontSize}px</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="增大字幕字号"
            disabled={!onFontSizeChange || fontSize >= 48}
            className="text-white/80 hover:bg-white/12 hover:text-white disabled:text-white/30"
            onClick={() => adjustFontSize(2)}
          >
            <Plus data-icon="inline-start" aria-hidden />
          </Button>
        </div>
      </div>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 text-white">
        <Field
          orientation="horizontal"
          className="h-8 w-auto min-w-0 gap-2 [&>[data-slot=field-label]]:flex-none"
        >
          <FieldLabel htmlFor={translationId} className="text-white/85">
            开启翻译
          </FieldLabel>
          <Switch
            id={translationId}
            size="sm"
            checked={translationActive}
            disabled={!onTranslationActiveChange}
            aria-label="开启翻译"
            onCheckedChange={(checked) => onTranslationActiveChange?.(checked)}
          />
        </Field>
        {onOpenWindow ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="在独立窗口显示字幕"
            title="在独立窗口显示字幕"
            className="text-white/80 hover:bg-white/12 hover:text-white"
            onClick={onOpenWindow}
          >
            <AppWindow aria-hidden />
          </Button>
        ) : null}
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="关闭字幕"
            title="关闭字幕"
            className="text-white/80 hover:bg-white/12 hover:text-white"
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  ) : null;

  const aspectRatio =
    videoAspectRatio != null && Number.isFinite(videoAspectRatio) && videoAspectRatio > 0
      ? videoAspectRatio
      : null;
  // 轨道取画面宽的 92%；画幅未知时就是播放器宽的 92%，已知时按 contain 后的实际画幅收窄。
  const trackWidth = aspectRatio ? `min(92cqw, ${(aspectRatio * 92).toFixed(4)}cqh)` : "92cqw";
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
          {/* 顶栏先占高度，正文容量再缩到其余可用空间；空占位与正文完全同宽同高。 */}
          <div
            className={cn(
              "flex min-h-0 w-full max-w-full flex-col overflow-hidden rounded-md border border-white/10 bg-black/78 shadow-md @container/asr-caption",
              asr.noticeIsError && asr.notice && "border-destructive/45",
            )}
            style={{ maxHeight: "min(100%, var(--asr-picture-height))" }}
          >
            {toolbar}
            {hasContent || showToolbar ? (
              // live region 只包字幕文字，语言控件和窗口按钮不会被重复播报。
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="flex min-h-0 w-full shrink flex-col justify-end overflow-hidden"
                style={{ fontSize: `${fontSize}px`, height: captionCapacityHeight }}
              >
                {hasContent ? captionBox : null}
              </div>
            ) : (
              emptyCaptionBox
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
