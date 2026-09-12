import { useEffect, useState, type ReactNode } from "react";
import {
  Captions,
  CaptionsOff,
  Check,
  Expand,
  Eye,
  EyeOff,
  Headphones,
  Maximize2,
  MessageSquareOff,
  MessageSquareText,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Settings,
  Shrink,
  SkipForward,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Time } from "@videojs/react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { ButtonTooltip } from "@/components/videojs/ui/button-tooltip";
import { FullscreenButton } from "@/components/videojs/ui/fullscreen-button";
import { PiPButton } from "@/components/videojs/ui/pip-button";
import { PlayButton } from "@/components/videojs/ui/play-button";
import { TimeSlider } from "@/components/videojs/ui/time-slider";
import { VolumePopover } from "@/components/videojs/ui/volume-popover";
import {
  ControlsSurface,
  type ControlsChromeProps,
} from "@/components/videojs/skins/shared/controls-surface";
import { useSkinVariant } from "@/components/videojs/skins/variant";
import { cn } from "@/lib/utils";
import { lineName } from "@/lib/playUrl";
import { usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import {
  TRANSLATION_LANGUAGE_OPTIONS,
  TRANSLATION_SOURCE_LANGUAGE_OPTIONS,
} from "@/shared/translation/languages";
import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
  PlayUrl,
} from "@/shared/types/live";
import {
  glassMutedTextClass,
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassSeparatorClass,
  glassTitleClass,
} from "./glassSurface";

export function danmakuControlPresentation(osdOn: boolean | undefined) {
  const enabled = Boolean(osdOn);
  return {
    enabled,
    label: enabled ? "关闭弹幕" : "开启弹幕",
    icon: enabled ? "message-square-text" : "message-square-off",
  } as const;
}

export function audioOnlyControlPresentation(audioOnly: boolean) {
  return {
    enabled: audioOnly,
    label: audioOnly ? "恢复画面" : "仅播声音",
    icon: audioOnly ? "headphones" : "video-off",
  } as const;
}

export function volumeControlPresentation(volume: number, muted = false) {
  const isMuted = muted || volume === 0;
  const roundedVolume = Math.round(volume);
  return {
    isMuted,
    label: isMuted ? "调节音量（当前静音）" : `调节音量（当前 ${roundedVolume}%）`,
    icon: isMuted ? "volume-x" : "volume-2",
  } as const;
}

export function asrControlPresentation(enabled: boolean, busy: boolean) {
  return {
    enabled,
    icon: busy ? "spinner" : enabled ? "captions" : "captions-off",
  } as const;
}

export function showSecondaryPlayerControls(compact: boolean, portrait: boolean): boolean {
  return !(compact && portrait);
}

/**
 * 只作用于绑定 Android 原生音量桥的业务音量控件（Web 路径用原生 VolumePopover）。
 * 移动端全屏已有边缘滑动调音量，控制条去掉这个按钮保持舞台简洁。
 */
export function showPlayerVolumeControl(
  compact: boolean,
  portrait: boolean,
  fullscreen: boolean,
): boolean {
  if (compact && fullscreen) return false;
  return showSecondaryPlayerControls(compact, portrait);
}

export function showPlayerSidePanelControl(
  compact: boolean,
  portrait: boolean,
  fullscreen: boolean,
): boolean {
  if (!compact || fullscreen) return false;
  return showSecondaryPlayerControls(compact, portrait);
}

export function showPlayerWebFullscreenControl(compact: boolean, fullscreen: boolean): boolean {
  return !compact && !fullscreen;
}

export function playerControlsAvoidSystemGestureBar(
  fullscreen: boolean,
  stackedBelowPlayer: boolean,
): boolean {
  return fullscreen || !stackedBelowPlayer;
}

export type ExternalPlayerAudioControls = {
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
};

export type PlayerControlsProps = {
  /** 控制层外壳：定位类名、ref、显隐 data 属性与指针/焦点事件由播放页提供。 */
  chrome?: ControlsChromeProps;
  externalAudioControls?: ExternalPlayerAudioControls;
  audioOnly?: boolean;
  sidePanelOpen?: boolean;
  sidePanelLabel?: string;
  webFullscreen?: boolean;
  osdOn?: boolean;
  asrVisible?: boolean;
  asrOn?: boolean;
  asrLabel?: string;
  asrDisabled?: boolean;
  asrBusy?: boolean;
  asrTranslationEnabled?: boolean;
  asrTranslationFrom?: CaptionTranslationSourceLanguage;
  asrTranslationTo?: CaptionTranslationLanguage;
  asrTranslationBusy?: boolean;
  asrSpeakerDiarizationEnabled?: boolean;
  asrSettingsPending?: boolean;
  qualities?: { quality: string; disabled?: boolean; hint?: string }[];
  qualityIndex?: number;
  lines?: PlayUrl[];
  lineIndex?: number;
  fullscreen?: boolean;
  nativeFullscreen?: boolean;
  pictureInPictureDisabled?: boolean;
  /** 字幕控件：常驻右侧按钮组、位于全屏按钮左侧，由各播放页提供具体菜单。 */
  captionsSlot?: ReactNode;
  disabled?: boolean;
  stackedBelowPlayer?: boolean;
  systemGestureBarReserved?: boolean;
  centerSlot?: ReactNode;
  playbackSettings?: ReactNode;
  playbackSettingsTitle?: string;
  playbackSettingsLabel?: string;
  playbackSettingsDisabled?: boolean;
  compact?: boolean;
  portalContainer?: HTMLElement | React.RefObject<HTMLElement | null> | null;
  onOverlayInteractionChange?: (open: boolean) => void;
  refreshDisabled?: boolean;
  loadError?: string | null;
  onRefresh?: () => void;
  onNext?: () => void;
  onToggleAudioOnly?: () => void;
  onToggleSidePanel?: () => void;
  onToggleWebFullscreen?: () => void;
  onToggleOsd?: () => void;
  onToggleAsr?: () => void;
  onAsrTranslationEnabledChange?: (enabled: boolean) => void;
  onAsrTranslationFromChange?: (from: CaptionTranslationSourceLanguage) => void;
  onAsrTranslationToChange?: (to: CaptionTranslationLanguage) => void;
  onAsrSpeakerDiarizationEnabledChange?: (enabled: boolean) => void | Promise<void>;
  onQualityChange?: (index: number) => void;
  onLineChange?: (index: number) => void;
  toolsSlot?: ReactNode;
  infoVisible?: boolean;
  onToggleInfo?: () => void;
  onToggleFullscreen?: () => void;
};

export const PLAYER_CONTROL_BUTTON_CLASS = "shrink-0";
export const PLAYER_CONTROL_ICON_CLASS = "[&_svg]:size-6";
export const PLAYER_OVERLAY_CONTROL_BUTTON_CLASS =
  "text-media-controls-foreground hover:bg-media-accent hover:text-media-accent-foreground";

/**
 * 画面之上 HUD 图标按钮的唯一样式配方：与底部控制栏同一套 36px MediaButton、
 * 圆角与 hover。返回箭头、溢出菜单、录制与关注共用它 —— 新增 HUD 按钮必须走
 * 这里，否则就会像之前的录制按钮那样长出一个尺寸与配色都对不上的按钮。
 */
export const PLAYER_HUD_BUTTON_CLASS = `r-live-media-extension-button shrink-0 ${PLAYER_OVERLAY_CONTROL_BUTTON_CLASS}`;

/** HUD 按钮内的图标尺寸，与控制栏 24px 图标对齐。 */
export const PLAYER_HUD_ICON_CLASS = "size-6";

/**
 * 画面之上 HUD 标题（房间名、视频名、频道名）的统一字号：直播、多画面、视频与
 * IPTV 四处顶部 HUD 共用 16px，比应用顶栏标题大一档 —— 画面上的标题要在明暗画面、
 * 远距离和移动端小屏上都一眼可读。之前四处各写一套（`text-base` / `text-sm` /
 * `text-xs`），同一位置的标题在四个页面之间大小对不上。
 *
 * 只管字号：字重、配色、底色与投影仍归各调用点，它们的画法本来就不同（IPTV 频道名
 * 带胶囊底色，直播标题靠投影）。
 */
export const PLAYER_HUD_TITLE_SIZE_CLASS = "text-base";

function ExtensionButton({
  label,
  active,
  disabled,
  tooltip = true,
  className,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  tooltip?: boolean;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const button = (
    <MediaButton
      type="button"
      aria-label={label}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "r-live-media-extension-button",
        active && "bg-media-primary text-media-primary-foreground",
        className,
      )}
    >
      {children}
    </MediaButton>
  );
  return tooltip ? (
    // 业务按钮不在 Video.js 的 tooltip context 里，文案必须显式交给 tooltip，
    // 否则只会弹出一个空框。
    <ButtonTooltip label={label} side="top">
      {button}
    </ButtonTooltip>
  ) : (
    button
  );
}

function SettingsBody({
  qualities,
  qualityIndex,
  lines,
  lineIndex,
  playbackSettings,
  onQualityChange,
  onLineChange,
  onClose,
}: Pick<
  PlayerControlsProps,
  | "qualities"
  | "qualityIndex"
  | "lines"
  | "lineIndex"
  | "playbackSettings"
  | "onQualityChange"
  | "onLineChange"
> & { onClose: () => void }) {
  const optionClass = glassOptionClass();
  const qualityLabel = (index: number) => {
    const label = qualities?.[index]?.quality?.trim();
    if (!label || /^(?:rate)?\d+$/i.test(label)) {
      return ["原画", "蓝光", "超清", "高清", "流畅", "标清"][index] ?? "可用清晰度";
    }
    return label;
  };
  return (
    <div className="flex flex-col gap-1">
      {(qualities?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className={cn("px-2 pt-1 text-xs", glassMutedTextClass())}>清晰度</span>
          {qualities?.map((quality, index) => (
            <Button
              key={`${quality.quality}-${index}`}
              variant="ghost"
              size="sm"
              disabled={quality.disabled}
              title={quality.hint}
              aria-pressed={index === qualityIndex}
              className={cn(
                "w-full justify-between",
                optionClass,
                index === qualityIndex && glassOptionSelectedClass(),
              )}
              onClick={() => {
                onQualityChange?.(index);
                onClose();
              }}
            >
              <span className="truncate">{qualityLabel(index)}</span>
              {index === qualityIndex && <Check data-icon="inline-end" aria-hidden />}
            </Button>
          ))}
        </div>
      )}
      {(qualities?.length ?? 0) > 0 && (lines?.length ?? 0) > 0 && (
        <Separator className={glassSeparatorClass()} />
      )}
      {(lines?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className={cn("px-2 pt-1 text-xs", glassMutedTextClass())}>线路</span>
          {lines?.map((line, index) => (
            <Button
              key={`${line.url}-${index}`}
              variant="ghost"
              size="sm"
              aria-pressed={index === lineIndex}
              className={cn(
                "w-full justify-between",
                optionClass,
                index === lineIndex && glassOptionSelectedClass(),
              )}
              onClick={() => {
                onLineChange?.(index);
                onClose();
              }}
            >
              <span className="truncate">{lineName(line, index)}</span>
              {index === lineIndex && <Check data-icon="inline-end" aria-hidden />}
            </Button>
          ))}
        </div>
      )}
      {playbackSettings}
    </div>
  );
}

export type AsrSettingsBodyProps = {
  portalContainer?: HTMLElement | React.RefObject<HTMLElement | null> | null;
  translationEnabled: boolean;
  translationFrom: CaptionTranslationSourceLanguage;
  translationTo: CaptionTranslationLanguage;
  speakerDiarizationEnabled: boolean;
  onTranslationEnabledChange?: (enabled: boolean) => void;
  onTranslationFromChange?: (from: CaptionTranslationSourceLanguage) => void;
  onTranslationToChange?: (to: CaptionTranslationLanguage) => void;
  onSpeakerDiarizationEnabledChange?: (enabled: boolean) => void | Promise<void>;
};

/** 直播字幕按钮与 VOD「字幕（本地）」二级页共用的识别设置。 */
export function AsrSettingsBody({
  portalContainer,
  translationEnabled,
  translationFrom,
  translationTo,
  speakerDiarizationEnabled,
  onTranslationEnabledChange,
  onTranslationFromChange,
  onTranslationToChange,
  onSpeakerDiarizationEnabledChange,
}: AsrSettingsBodyProps) {
  return (
    <FieldGroup className="gap-3">
      <Field orientation="horizontal">
        <FieldLabel htmlFor="player-speaker-diarization">区分说话人</FieldLabel>
        <Switch
          id="player-speaker-diarization"
          size="sm"
          checked={speakerDiarizationEnabled}
          disabled={!onSpeakerDiarizationEnabledChange}
          onCheckedChange={(checked) => void onSpeakerDiarizationEnabledChange?.(checked)}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="player-caption-translation">字幕翻译</FieldLabel>
        <Switch
          id="player-caption-translation"
          size="sm"
          checked={translationEnabled}
          disabled={!onTranslationEnabledChange}
          onCheckedChange={onTranslationEnabledChange}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="player-caption-translation-from">原文语言</FieldLabel>
        <Select
          items={TRANSLATION_SOURCE_LANGUAGE_OPTIONS}
          value={translationFrom}
          onValueChange={(value) => value && onTranslationFromChange?.(value)}
        >
          <SelectTrigger id="player-caption-translation-from" size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent container={portalContainer} side="top" align="end" glass>
            <SelectGroup>
              {TRANSLATION_SOURCE_LANGUAGE_OPTIONS.map((language) => (
                <SelectItem key={language.value} value={language.value}>
                  {language.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="player-caption-translation-to">译文语言</FieldLabel>
        <Select
          items={TRANSLATION_LANGUAGE_OPTIONS}
          value={translationTo}
          onValueChange={(value) => value && onTranslationToChange?.(value)}
        >
          <SelectTrigger id="player-caption-translation-to" size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent container={portalContainer} side="top" align="end" glass>
            <SelectGroup>
              {TRANSLATION_LANGUAGE_OPTIONS.map((language) => (
                <SelectItem key={language.value} value={language.value}>
                  {language.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  );
}
export function PlayerControls({
  chrome,
  externalAudioControls,
  audioOnly = false,
  sidePanelOpen = false,
  sidePanelLabel,
  webFullscreen = false,
  osdOn,
  asrVisible = false,
  asrOn = false,
  asrLabel = asrOn ? "关闭语音字幕" : "开启语音字幕",
  asrDisabled = false,
  asrBusy = false,
  asrTranslationEnabled = false,
  asrTranslationFrom = "auto",
  asrTranslationTo = "zh-CN",
  asrTranslationBusy = false,
  asrSpeakerDiarizationEnabled = false,
  asrSettingsPending = false,
  qualities = [],
  qualityIndex = 0,
  lines = [],
  lineIndex = 0,
  fullscreen = false,
  nativeFullscreen = false,
  pictureInPictureDisabled,
  captionsSlot,
  stackedBelowPlayer = false,
  systemGestureBarReserved = false,
  disabled = false,
  compact = false,
  centerSlot,
  playbackSettings,
  playbackSettingsTitle = "播放设置",
  playbackSettingsLabel,
  playbackSettingsDisabled,
  portalContainer,
  onOverlayInteractionChange,
  refreshDisabled = disabled,
  loadError,
  onRefresh,
  onNext,
  onToggleAudioOnly,
  onToggleSidePanel,
  onToggleWebFullscreen,
  onToggleOsd,
  onToggleAsr,
  onAsrTranslationEnabledChange,
  onAsrTranslationFromChange,
  onAsrTranslationToChange,
  onAsrSpeakerDiarizationEnabledChange,
  onQualityChange,
  onLineChange,
  toolsSlot,
  infoVisible = true,
  onToggleInfo,
  onToggleFullscreen,
}: PlayerControlsProps) {
  const variant = useSkinVariant();
  const portrait = usePortraitOrientation();
  const showSecondary = showSecondaryPlayerControls(compact, portrait);
  const showVolume = showPlayerVolumeControl(compact, portrait, fullscreen);
  const showSidePanel = showPlayerSidePanelControl(compact, portrait, fullscreen);
  const showWebFullscreen = showPlayerWebFullscreenControl(compact, fullscreen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [asrOpen, setAsrOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const settingsVisible = qualities.length > 0 || lines.length > 0 || playbackSettings != null;
  const settingsDisabled = playbackSettingsDisabled ?? (disabled && playbackSettings == null);
  const danmaku = danmakuControlPresentation(osdOn);
  const audio = audioOnlyControlPresentation(audioOnly);
  const asr = asrControlPresentation(asrOn, asrBusy);
  const externalVolume = volumeControlPresentation(
    externalAudioControls?.volume ?? 0,
    externalAudioControls?.muted,
  );
  const overlayOpen = settingsOpen || asrOpen || volumeOpen;

  useEffect(
    () => onOverlayInteractionChange?.(overlayOpen),
    [onOverlayInteractionChange, overlayOpen],
  );
  useEffect(() => () => onOverlayInteractionChange?.(false), [onOverlayInteractionChange]);
  const settingsBody = (
    <SettingsBody
      qualities={qualities}
      qualityIndex={qualityIndex}
      lines={lines}
      lineIndex={lineIndex}
      playbackSettings={playbackSettings}
      onQualityChange={onQualityChange}
      onLineChange={onLineChange}
      onClose={() => setSettingsOpen(false)}
    />
  );


  const asrBody = (
    <AsrSettingsBody
      portalContainer={portalContainer}
      translationEnabled={asrTranslationEnabled}
      translationFrom={asrTranslationFrom}
      translationTo={asrTranslationTo}
      speakerDiarizationEnabled={asrSpeakerDiarizationEnabled}
      onTranslationEnabledChange={onAsrTranslationEnabledChange}
      onTranslationFromChange={onAsrTranslationFromChange}
      onTranslationToChange={onAsrTranslationToChange}
      onSpeakerDiarizationEnabledChange={onAsrSpeakerDiarizationEnabledChange}
    />
  );

  // 容器宽度不足时按优先级让位：与原生控件同一套 media 容器断点，
  // 保证业务按钮行永远不会被 `overflow-hidden` 拦腰截断。
  const secondaryClass = "media-max-sm:hidden";

  return (
    <ControlsSurface
      chrome={chrome}
      avoidSystemGestureBar={
        !systemGestureBarReserved &&
        playerControlsAvoidSystemGestureBar(fullscreen, stackedBelowPlayer)
      }
    >
      {/* 点播/录制回放：上方展示进度条 */}
      {variant === "vod" && (
        <div className="flex w-full min-w-0 items-center gap-2 px-2 pt-1 pb-0.5">
          <Time.Value className="shrink-0 text-xs tabular-nums text-white/90" type="current" />
          <TimeSlider className="flex-1" />
          <Time.Value
            className="shrink-0 text-xs tabular-nums text-white/70 hover:text-white"
            type="remaining"
            toggle
          />
        </div>
      )}

      {/* 控制条主行：左侧为暂停|刷新|音量|仅音频，中间为弹幕发送栏，右侧为设置|弹幕|字幕|画中画|窗口全屏|全屏 */}
      <div
        data-slot="player-extension-controls"
        data-compact={compact || undefined}
        className="flex w-full min-w-0 items-center justify-between gap-2 px-2 py-1"
      >
        {/* 左侧控制栏：暂停 | 刷新 | 音量 | 仅音频 */}
        <div className="flex shrink-0 items-center gap-1">
          {/* 1. 暂停 / 播放 */}
          <ButtonTooltip side="top">
            <PlayButton disabled={disabled} />
          </ButtonTooltip>

          {/* 2. 刷新 */}
          {onRefresh && (
            <ExtensionButton
              label="刷新播放"
              disabled={refreshDisabled}
              onClick={onRefresh}
            >
              <RefreshCw className={refreshDisabled ? "animate-spin-soft" : undefined} />
            </ExtensionButton>
          )}
          {onNext && showSecondary && (
            <ExtensionButton
              label="播放下一个"
              disabled={disabled}
              onClick={onNext}
            >
              <SkipForward />
            </ExtensionButton>
          )}

          {/* 3. 音量 */}
          {showVolume &&
            (externalAudioControls ? (
              <Popover open={volumeOpen} onOpenChange={setVolumeOpen}>
                <PopoverTrigger
                  openOnHover
                  render={
                    <MediaButton
                      aria-label={externalVolume.label}
                      aria-pressed={externalVolume.isMuted}
                      onClick={externalAudioControls.onToggleMute}
                      className="r-live-media-extension-button"
                    >
                      {externalVolume.isMuted ? <VolumeX /> : <Volume2 />}
                    </MediaButton>
                  }
                />
                <PopoverContent
                  container={portalContainer}
                  side="top"
                  align="start"
                  collisionPadding={12}
                  sticky
                  glass
                  className={cn("w-auto items-center gap-2 p-2.5", glassPanelClass({ overlay: true }))}
                >
                  <PopoverTitle className="sr-only">音量</PopoverTitle>
                  <Slider
                    value={externalAudioControls.volume}
                    min={0}
                    max={100}
                    step={1}
                    orientation="vertical"
                    className={cn("h-32", compact && "h-20 [&_[data-slot=slider-control]]:min-h-20")}
                    aria-label="音量"
                    aria-valuetext={`${Math.round(externalAudioControls.volume)}%`}
                    onValueChange={(next) =>
                      externalAudioControls.onVolumeChange(
                        Number(Array.isArray(next) ? next[0] : next),
                      )
                    }
                  />
                  <Separator className={cn("w-8", glassSeparatorClass())} />
                  <MediaButton
                    type="button"
                    aria-label={externalVolume.isMuted ? "取消静音" : "静音"}
                    aria-pressed={externalVolume.isMuted}
                    onClick={externalAudioControls.onToggleMute}
                    className={cn(
                      "r-live-media-extension-button",
                      externalVolume.isMuted && glassOptionSelectedClass(),
                    )}
                  >
                    <VolumeX />
                  </MediaButton>
                </PopoverContent>
              </Popover>
            ) : (
              <VolumePopover />
            ))}

          {/* 4. 仅音频 */}
          {showSecondary && onToggleAudioOnly && (
            <ExtensionButton
              label={audio.label}
              active={audio.enabled}
              onClick={onToggleAudioOnly}
            >
              {audio.enabled ? <Headphones /> : <VideoOff />}
            </ExtensionButton>
          )}
        </div>

        {/* 中间：弹幕发送栏 */}
        <div
          data-slot="player-center-slot"
          className="flex min-w-0 flex-1 items-center justify-center px-2"
        >
          {centerSlot ? (
            <div className="w-full max-w-xl min-w-0">
              {centerSlot}
            </div>
          ) : (
            <div className="min-w-0 flex-1" />
          )}
          {loadError && (
            <span className="shrink-0 max-w-36 truncate px-1 text-xs text-red-300" title={loadError}>
              {loadError}
            </span>
          )}
        </div>

        {/* 右侧控制栏：设置 | 弹幕 | 字幕 | 画中画 | 窗口全屏 | 全屏 */}
        <div className="flex shrink-0 items-center gap-1">
          {/* 1. 设置 */}
          {settingsVisible &&
            (compact ? (
              <>
                <ExtensionButton
                  label={playbackSettingsLabel ?? playbackSettingsTitle}
                  active={settingsOpen}
                  disabled={settingsDisabled}
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  <Settings />
                </ExtensionButton>
                <Drawer open={settingsOpen} onOpenChange={setSettingsOpen}>
                  <DrawerContent
                    side={portrait ? "bottom" : "right"}
                    container={portalContainer}
                    glass
                    className={glassPanelClass({ overlay: true })}
                  >
                    <DrawerTitle className={glassTitleClass({ overlay: true })}>
                      {playbackSettingsTitle}
                    </DrawerTitle>
                    {settingsBody}
                  </DrawerContent>
                </Drawer>
              </>
            ) : (
              <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
                <PopoverTrigger
                  openOnHover
                  render={
                    <MediaButton
                      aria-label={playbackSettingsLabel ?? playbackSettingsTitle}
                      aria-disabled={settingsDisabled || undefined}
                      disabled={settingsDisabled}
                      className="r-live-media-extension-button"
                    >
                      <Settings />
                    </MediaButton>
                  }
                />
                <PopoverContent
                  container={portalContainer}
                  side="top"
                  align="end"
                  collisionPadding={12}
                  sticky
                  glass
                  className={cn(
                    "z-50 max-h-[min(30rem,calc(100dvh-5rem))] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto p-1.5",
                    glassPanelClass({ overlay: true }),
                  )}
                >
                  <PopoverTitle className={glassTitleClass({ overlay: true })}>
                    {playbackSettingsTitle}
                  </PopoverTitle>
                  {settingsBody}
                </PopoverContent>
              </Popover>
            ))}

          {/* 2. 弹幕 */}
          {showSecondary && onToggleOsd && (
            <ExtensionButton
              label={danmaku.label}
              active={danmaku.enabled}
              onClick={onToggleOsd}
            >
              {danmaku.enabled ? <MessageSquareText /> : <MessageSquareOff />}
            </ExtensionButton>
          )}

          {/* 3. 字幕 */}
          {showSecondary && asrVisible && onToggleAsr && (
            <Popover open={asrOpen} onOpenChange={setAsrOpen}>
              <PopoverTrigger
                openOnHover
                render={
                  <MediaButton
                    aria-label={asrLabel}
                    aria-pressed={asr.enabled}
                    aria-disabled={asrDisabled || undefined}
                    disabled={asrDisabled}
                    onClick={onToggleAsr}
                    className={cn(
                      "r-live-media-extension-button",
                      asr.enabled && "bg-media-primary text-media-primary-foreground",
                    )}
                  >
                    {asr.icon === "spinner" ? (
                      <Spinner />
                    ) : asr.icon === "captions" ? (
                      <Captions />
                    ) : (
                      <CaptionsOff />
                    )}
                  </MediaButton>
                }
              />
              <PopoverContent
                container={portalContainer}
                side="top"
                align="end"
                collisionPadding={12}
                sticky
                glass
                className={cn("w-72", glassPanelClass({ overlay: true }))}
              >
                <div className="flex items-center justify-between gap-2">
                  <PopoverTitle className={glassTitleClass({ overlay: true })}>字幕设置</PopoverTitle>
                  {(asrSettingsPending || asrTranslationBusy) && (
                    <Spinner aria-label="正在更新字幕设置" />
                  )}
                </div>
                {asrBody}
              </PopoverContent>
            </Popover>
          )}

          {/* 4. 字幕：常驻控制栏，不可用时为禁用按钮（位置固定在全屏按钮左侧）。 */}
          {captionsSlot}

          {/* 5. 画中画：交给原生 PiPButton —— 它按 `pipAvailability` 自行隐藏，
              移动端 WebView 不支持画中画时不会再留下一个点了没反应的按钮。 */}
          <ButtonTooltip side="top">
            <PiPButton
              className="media-max-xs:hidden"
              // 原生标签走 Video.js 英文 i18n，这里显式给中文，与其余控件一致。
              label={(state) => (state.pip ? "退出画中画" : "画中画")}
              disabled={pictureInPictureDisabled}
            />
          </ButtonTooltip>

          {/* 6. 窗口全屏 */}
          {showWebFullscreen && onToggleWebFullscreen && (
            <ExtensionButton
              label={webFullscreen ? "退出网页全屏" : "网页全屏"}
              active={webFullscreen}
              onClick={onToggleWebFullscreen}
            >
              {webFullscreen ? <Shrink /> : <Expand />}
            </ExtensionButton>
          )}

          {/* 7. 全屏 */}
          {nativeFullscreen ? (
            <ButtonTooltip side="top">
              <FullscreenButton />
            </ButtonTooltip>
          ) : onToggleFullscreen ? (
            <ExtensionButton
              label={fullscreen ? "退出全屏" : "全屏"}
              active={fullscreen}
              onClick={onToggleFullscreen}
            >
              {fullscreen ? <Minimize2 /> : <Maximize2 />}
            </ExtensionButton>
          ) : null}

          {/* 辅助扩展按钮 */}
          {showSidePanel && onToggleSidePanel && (
            <ExtensionButton
              className={secondaryClass}
              label={sidePanelLabel ?? (sidePanelOpen ? "收起右侧栏" : "展开右侧栏")}
              active={sidePanelOpen}
              onClick={onToggleSidePanel}
            >
              {sidePanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </ExtensionButton>
          )}
          {onToggleInfo && showSecondary && (
            <ExtensionButton
              className={secondaryClass}
              label={infoVisible ? "隐藏用户和视频信息" : "显示用户和视频信息"}
              active={!infoVisible}
              onClick={onToggleInfo}
            >
              {infoVisible ? <EyeOff /> : <Eye />}
            </ExtensionButton>
          )}
          {toolsSlot}
        </div>
      </div>
    </ControlsSurface>
  );
}

