import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  Captions,
  CaptionsOff,
  Check,
  Headphones,
  Maximize2,
  MessageSquareOff,
  MessageSquareText,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  Settings,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
import { usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { lineName } from "@/lib/playUrl";
import { cn } from "@/lib/utils";
import {
  glassMutedTextClass,
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassSeparatorClass,
} from "./glassSurface";
import {
  TRANSLATION_LANGUAGE_OPTIONS,
  TRANSLATION_SOURCE_LANGUAGE_OPTIONS,
} from "@/shared/translation/languages";
import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
  PlayUrl,
} from "@/shared/types/live";

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
 * Mobile fullscreen already exposes edge-swipe volume and hides the side panel
 * chrome, so the bar drops those two buttons to keep the stage uncluttered.
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
  if (compact && fullscreen) return false;
  return showSecondaryPlayerControls(compact, portrait);
}

export function showPlayerControlsCenterSlot(compact: boolean, fullscreen: boolean): boolean {
  return !compact || fullscreen;
}

/**
 * Whether the overlay chrome should reserve room for the system gesture bar.
 *
 * `env(safe-area-inset-bottom)` describes the window, not this element. The
 * inset is only real padding when the controls actually sit on the bottom
 * window edge: fullscreen, or a player that fills the viewport down to it.
 * Portrait rooms stack danmaku below the picture, so the controls float over
 * the video's bottom edge with the panel — not the gesture bar — underneath.
 * Padding there would push the buttons up off the picture by the inset height,
 * which is exactly the gap that shows up on a cold start (Android reports the
 * inset) and disappears after a fullscreen round trip (the WebView leaves it
 * collapsed at 0) — same layout, two different renderings of the same bug.
 */
export function playerControlsAvoidSystemGestureBar(
  fullscreen: boolean,
  stackedBelowPlayer: boolean,
): boolean {
  return fullscreen || !stackedBelowPlayer;
}

export type PlayerControlsProps = {
  paused: boolean;
  volume: number;
  muted?: boolean;
  audioOnly?: boolean;
  sidePanelOpen?: boolean;
  /** Changes with the responsive side-panel presentation (rail vs. drawer). */
  sidePanelLabel?: string;
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
  qualities?: { quality: string }[];
  qualityIndex?: number;
  lines?: PlayUrl[];
  lineIndex?: number;
  fullscreen?: boolean;
  pictureInPictureSupported?: boolean;
  pictureInPictureActive?: boolean;
  pictureInPictureDisabled?: boolean;
  disabled?: boolean;
  /** Use when controls are rendered over the bottom edge of the video. */
  overlay?: boolean;
  /**
   * Set when content (portrait danmaku panel, page footer) is stacked below
   * the player, so the controls do not sit on the window's bottom edge and
   * must not reserve space for the system gesture bar.
   */
  stackedBelowPlayer?: boolean;
  /** Optional compact content centered between transport and room controls. */
  centerSlot?: ReactNode;
  /**
   * Compact viewport (portrait phones + short landscape). Drops desktop-only
   * keyboard hints from labels so the chrome reads shorter on a small screen.
   */
  compact?: boolean;
  /**
   * Portal target for the settings/volume popovers. Under a `:fullscreen`
   * ancestor the top layer owns the stacking context, so a portal rendered to
   * <body> stacks beneath the fullscreen element — render inside the stage
   * instead so the popover stays above the controls bar.
   */
  portalContainer?: HTMLElement | React.RefObject<HTMLElement | null> | null;
  /**
   * The menu content is portalled outside the player stage. Tell the stage
   * when one is open so its idle timer cannot fade out beneath a menu.
   */
  onOverlayInteractionChange?: (open: boolean) => void;
  refreshDisabled?: boolean;
  loadError?: string | null;
  onRefresh?: () => void;
  onTogglePause: () => void;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onToggleAudioOnly?: () => void;
  onToggleSidePanel?: () => void;
  onToggleOsd?: () => void;
  onToggleAsr?: () => void;
  onAsrTranslationEnabledChange?: (enabled: boolean) => void;
  onAsrTranslationFromChange?: (from: CaptionTranslationSourceLanguage) => void;
  onAsrTranslationToChange?: (to: CaptionTranslationLanguage) => void;
  onAsrSpeakerDiarizationEnabledChange?: (enabled: boolean) => void | Promise<void>;
  onQualityChange?: (index: number) => void;
  onLineChange?: (index: number) => void;
  onTogglePictureInPicture?: () => void;
  onToggleFullscreen: () => void;
};

type ControlButtonProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "size"
> & {
  label: string;
  children: ReactNode;
  /** Desktop hover tooltip. Disabled on compact touch layouts. */
  tooltip?: boolean;
};

/**
 * Video chrome reads from further away than in-page buttons, so the glyphs run
 * one small step above the shared button default (size-4).
 *
 * These three are exported because the fullscreen top HUD draws its own button
 * outside this bar; sharing the classes keeps the two chrome layers from
 * drifting apart in glyph size, hit area or focus treatment.
 */
export const PLAYER_CONTROL_ICON_CLASS = "[&_svg:not([class*='size-'])]:size-4.5";
/** Player chrome stays compact even when the shared coarse-pointer floor is 44px. */
export const PLAYER_CONTROL_BUTTON_CLASS =
  "size-9 [@media(pointer:coarse)]:size-9! [@media(pointer:coarse)]:min-h-9! [@media(pointer:coarse)]:min-w-9! [@media(pointer:coarse)]:touch-manipulation";
/** Trim for a chrome button drawn over video: white glyph on a scrim. */
export const PLAYER_OVERLAY_CONTROL_BUTTON_CLASS =
  "rounded-lg text-white/90 hover:bg-white/12 hover:text-white aria-expanded:bg-white/12 aria-expanded:text-white focus-visible:border-white/65 focus-visible:bg-white/16 focus-visible:ring-[2px]! focus-visible:ring-black/55 drop-shadow-[0_1px_2px_rgb(0_0_0_/_0.65)]";
const CONTROL_ICON_CLASS = PLAYER_CONTROL_ICON_CLASS;
const CONTROL_BUTTON_CLASS = PLAYER_CONTROL_BUTTON_CLASS;

function ControlButton({
  label,
  children,
  disabled,
  variant = "ghost",
  className,
  tooltip = true,
  ...props
}: ControlButtonProps) {
  const button = (
    <Button
      {...props}
      variant={variant}
      size="icon-sm"
      disabled={disabled}
      aria-label={label}
      className={cn(CONTROL_BUTTON_CLASS, CONTROL_ICON_CLASS, className)}
    >
      {children}
    </Button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Shared React controls kept separate from each feature's media lifecycle. */
export function PlayerControls({
  paused,
  volume,
  muted = false,
  audioOnly = false,
  sidePanelOpen = false,
  sidePanelLabel,
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
  pictureInPictureSupported = false,
  pictureInPictureActive = false,
  pictureInPictureDisabled = false,
  disabled = false,
  overlay = false,
  stackedBelowPlayer = false,
  compact = false,
  centerSlot,
  portalContainer,
  onOverlayInteractionChange,
  refreshDisabled = disabled,
  loadError,
  onRefresh,
  onTogglePause,
  onVolume,
  onToggleMute,
  onToggleAudioOnly,
  onToggleSidePanel,
  onToggleOsd,
  onToggleAsr,
  onAsrTranslationEnabledChange,
  onAsrTranslationFromChange,
  onAsrTranslationToChange,
  onAsrSpeakerDiarizationEnabledChange,
  onQualityChange,
  onLineChange,
  onTogglePictureInPicture,
  onToggleFullscreen,
}: PlayerControlsProps) {
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [streamSettingsOpen, setStreamSettingsOpen] = useState(false);
  const [asrSettingsOpen, setAsrSettingsOpen] = useState(false);
  const [asrSettingsError, setAsrSettingsError] = useState<string | null>(null);
  // Mobile settings open as a drawer: bottom sheet in portrait, right side in
  // landscape. The shared hook resolves orientation on the first paint and on
  // change from one source, so control density never renders at desktop size
  // for a frame before settling.
  const portrait = usePortraitOrientation();
  const showSecondaryControls = showSecondaryPlayerControls(compact, portrait);
  const showVolumeControl = showPlayerVolumeControl(compact, portrait, fullscreen);
  const showSidePanelControl = showPlayerSidePanelControl(compact, portrait, fullscreen);
  const avoidSystemGestureBar = playerControlsAvoidSystemGestureBar(fullscreen, stackedBelowPlayer);
  const mobilePortrait = !showSecondaryControls;
  const volumeControl = volumeControlPresentation(volume, muted);
  const isMuted = volumeControl.isMuted;
  const muteLabel = isMuted ? "取消静音" : "静音";
  const pauseLabel = compact ? "播放" : "播放（Space / K）";
  const pauseActiveLabel = compact ? "暂停" : "暂停（Space / K）";
  const fullscreenLabel = compact
    ? fullscreen
      ? "退出全屏"
      : "全屏"
    : fullscreen
      ? "退出全屏（F）"
      : "全屏（F）";
  const overlayButtonClass = overlay ? PLAYER_OVERLAY_CONTROL_BUTTON_CLASS : undefined;
  // Option rows come from the shared glass module so the player popups, the
  // settings drawer and the room sheet cannot drift apart.
  const overlayStreamSettingsOptionClass = glassOptionClass({ overlay }) || undefined;
  const overlayInteractionOpen = volumeOpen || streamSettingsOpen || asrSettingsOpen;

  useEffect(() => {
    onOverlayInteractionChange?.(overlayInteractionOpen);
  }, [onOverlayInteractionChange, overlayInteractionOpen]);

  useEffect(() => {
    if (!mobilePortrait && showVolumeControl) return;
    setVolumeOpen(false);
    if (!mobilePortrait) return;
    setAsrSettingsOpen(false);
  }, [mobilePortrait, showVolumeControl]);

  useEffect(
    () => () => {
      onOverlayInteractionChange?.(false);
    },
    [onOverlayInteractionChange],
  );

  useEffect(() => {
    if (!volumeOpen && !streamSettingsOpen && !asrSettingsOpen) return;
    const closeOnAndroidBack = (event: Event) => {
      event.preventDefault();
      setVolumeOpen(false);
      setStreamSettingsOpen(false);
      setAsrSettingsOpen(false);
    };
    window.addEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
  }, [asrSettingsOpen, streamSettingsOpen, volumeOpen]);

  const qualityLabel = (index: number) => {
    const label = qualities[index]?.quality?.trim();
    // The Select stores its index as the value. Do not expose that internal
    // value (or an upstream numeric-only label) in the player chrome.
    if (!label || /^(?:rate)?\d+$/i.test(label)) {
      return ["原画", "蓝光", "超清", "高清", "流畅", "标清"][index] ?? "可用清晰度";
    }
    return label;
  };

  const hasStreamSettings = qualities.length > 0 || lines.length > 0;
  const streamSettingsDisabled = disabled || (qualities.length <= 1 && lines.length <= 1);
  const streamSettingsLabel = [
    qualities.length > 0 ? `清晰度 ${qualityLabel(qualityIndex)}` : null,
    lines.length > 0 && lines[lineIndex] ? `线路 ${lineName(lines[lineIndex], lineIndex)}` : null,
  ]
    .filter(Boolean)
    .join("，");
  const closeStreamSettings = () => setStreamSettingsOpen(false);
  /**
   * Shared trigger glyph. On desktop this button *is* the popover trigger, so it
   * doubles as the positioning anchor — rendering a separate anchor would leave a
   * stray default-variant button visible in the bar.
   */
  const streamSettingsTriggerProps = {
    variant: "ghost",
    size: "icon-sm",
    disabled: streamSettingsDisabled,
    "aria-label": streamSettingsLabel ? `播放设置：${streamSettingsLabel}` : "播放设置",
    className: cn(CONTROL_BUTTON_CLASS, CONTROL_ICON_CLASS, overlayButtonClass),
  } as const;
  const danmakuControl = danmakuControlPresentation(osdOn);
  const DanmakuControlIcon =
    danmakuControl.icon === "message-square-text" ? MessageSquareText : MessageSquareOff;
  const asrControl = asrControlPresentation(asrOn, asrBusy);
  const audioOnlyControl = audioOnlyControlPresentation(audioOnly);
  const AudioOnlyControlIcon = audioOnlyControl.icon === "headphones" ? Headphones : VideoOff;
  const VolumeControlIcon = volumeControl.icon === "volume-x" ? VolumeX : Volume2;
  const resolvedSidePanelLabel = sidePanelLabel ?? (sidePanelOpen ? "收起右侧栏" : "展开右侧栏");
  /** Shared body of the stream settings popover/drawer. */
  const streamSettingsBody = (
    <>
      {qualities.length > 0 && (
        <div className="flex flex-col gap-0.5 max-md:gap-px">
          <span
            className={cn(
              "px-2 pt-1 text-xs text-muted-foreground max-md:pt-0.5",
              glassMutedTextClass({ overlay }),
            )}
          >
            清晰度
          </span>
          {qualities.map((quality, index) => {
            const selected = index === qualityIndex;
            return (
              <Button
                key={`${quality.quality}-${index}`}
                variant={overlay ? "ghost" : selected ? "secondary" : "ghost"}
                size="sm"
                className={cn(
                  "w-full justify-between max-md:h-10",
                  overlayStreamSettingsOptionClass,
                  selected && glassOptionSelectedClass({ overlay }),
                )}
                aria-pressed={selected}
                onClick={() => {
                  onQualityChange?.(index);
                  closeStreamSettings();
                }}
              >
                <span className="truncate">{qualityLabel(index)}</span>
                {selected && <Check data-icon="inline-end" aria-hidden />}
              </Button>
            );
          })}
        </div>
      )}

      {qualities.length > 0 && lines.length > 0 && (
        <Separator className={cn("my-1 max-md:my-0.5", glassSeparatorClass({ overlay }))} />
      )}

      {lines.length > 0 && (
        <div className="flex flex-col gap-0.5 max-md:gap-px">
          <span
            className={cn(
              "px-2 pt-1 text-xs text-muted-foreground max-md:pt-0.5",
              glassMutedTextClass({ overlay }),
            )}
          >
            线路
          </span>
          {lines.map((line, index) => {
            const selected = index === lineIndex;
            return (
              <Button
                key={`${line.url}-${index}`}
                variant={overlay ? "ghost" : selected ? "secondary" : "ghost"}
                size="sm"
                className={cn(
                  "w-full justify-between max-md:h-10",
                  overlayStreamSettingsOptionClass,
                  selected && glassOptionSelectedClass({ overlay }),
                )}
                aria-pressed={selected}
                onClick={() => {
                  onLineChange?.(index);
                  closeStreamSettings();
                }}
              >
                <span className="truncate">{lineName(line, index)}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {selected && <Check data-icon="inline-end" aria-hidden />}
                </span>
              </Button>
            );
          })}
        </div>
      )}
    </>
  );
  const captionSettingsBody = (
    <FieldGroup className="gap-3">
      <Field
        orientation="horizontal"
        data-disabled={asrSettingsPending || !onAsrSpeakerDiarizationEnabledChange || undefined}
      >
        <FieldLabel htmlFor="player-caption-speaker-diarization">说话人区分</FieldLabel>
        <Switch
          id="player-caption-speaker-diarization"
          size="sm"
          checked={asrSpeakerDiarizationEnabled}
          disabled={asrSettingsPending || !onAsrSpeakerDiarizationEnabledChange}
          onCheckedChange={(checked) => {
            setAsrSettingsError(null);
            void Promise.resolve(onAsrSpeakerDiarizationEnabledChange?.(checked)).catch(() => {
              setAsrSettingsError("说话人区分设置失败，请稍后重试。");
            });
          }}
        />
      </Field>

      {asrSettingsError && (
        <p role="status" className="text-xs text-destructive">
          {asrSettingsError}
        </p>
      )}

      <Separator className={cn(glassSeparatorClass({ overlay }))} />

      <Field orientation="horizontal">
        <FieldLabel htmlFor="player-caption-translation">字幕翻译</FieldLabel>
        <Switch
          id="player-caption-translation"
          size="sm"
          checked={asrTranslationEnabled}
          disabled={!onAsrTranslationEnabledChange}
          onCheckedChange={onAsrTranslationEnabledChange}
        />
      </Field>

      <Separator className={cn(glassSeparatorClass({ overlay }))} />

      <Field orientation="horizontal">
        <FieldLabel htmlFor="player-caption-translation-from">原文语言</FieldLabel>
        <Select
          items={TRANSLATION_SOURCE_LANGUAGE_OPTIONS}
          value={asrTranslationFrom}
          onValueChange={(value) => {
            if (value) onAsrTranslationFromChange?.(value);
          }}
        >
          <SelectTrigger
            id="player-caption-translation-from"
            size="sm"
            className={cn("w-32", overlay && "hover:bg-white/12 focus-visible:ring-white/70")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            container={portalContainer}
            side="top"
            align="end"
            alignItemWithTrigger={false}
            glass={overlay}
            className={cn("max-h-64", overlay && glassPanelClass({ overlay }))}
          >
            <SelectGroup>
              {TRANSLATION_SOURCE_LANGUAGE_OPTIONS.map((language) => (
                <SelectItem
                  key={language.value}
                  value={language.value}
                  disabled={language.value !== "auto" && language.value === asrTranslationTo}
                  className={overlayStreamSettingsOptionClass}
                >
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
          value={asrTranslationTo}
          onValueChange={(value) => {
            if (value) onAsrTranslationToChange?.(value);
          }}
        >
          <SelectTrigger
            id="player-caption-translation-to"
            size="sm"
            className={cn("w-32", overlay && "hover:bg-white/12 focus-visible:ring-white/70")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            container={portalContainer}
            side="top"
            align="end"
            alignItemWithTrigger={false}
            glass={overlay}
            className={cn("max-h-64", overlay && glassPanelClass({ overlay }))}
          >
            <SelectGroup>
              {TRANSLATION_LANGUAGE_OPTIONS.map((language) => (
                <SelectItem
                  key={language.value}
                  value={language.value}
                  disabled={language.value !== "auto" && language.value === asrTranslationFrom}
                  className={overlayStreamSettingsOptionClass}
                >
                  {language.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  );
  return (
    <div
      data-slot="player-controls-bar"
      data-compact={compact ? "true" : "false"}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1",
        compact && "justify-between gap-0.5",
        overlay
          ? // A scrim that fades up into the picture, the way ordinary video
            // players draw their bottom chrome — no top border, no blur, no
            // panel edge. The gradient reaches every player edge; safe-area
            // spacing stays inside the surface so it never creates a gutter.
            // The bottom inset applies only when the chrome really sits on the
            // window edge (see playerControlsAvoidSystemGestureBar).
            // Extra top padding gives the fade room to resolve before the
            // first control.
            cn(
              "player-scrim-overlay bg-transparent pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.375rem,env(safe-area-inset-left))] text-white",
              compact ? "pt-1.5" : "pt-3",
              avoidSystemGestureBar
                ? compact
                  ? "pb-[max(1px,env(safe-area-inset-bottom))]"
                  : "pb-[max(0.25rem,env(safe-area-inset-bottom))]"
                : compact
                  ? "pb-px"
                  : "pb-1",
            )
          : "border-t border-border bg-card px-1.5 py-1",
      )}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        {onRefresh && (
          <ControlButton
            label="刷新播放"
            className={cn(overlayButtonClass)}
            disabled={refreshDisabled}
            onClick={onRefresh}
            tooltip={!compact}
          >
            <RefreshCw />
          </ControlButton>
        )}
        <ControlButton
          label={paused ? pauseLabel : pauseActiveLabel}
          className={overlayButtonClass}
          disabled={disabled}
          onClick={onTogglePause}
          tooltip={!compact}
        >
          {paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
        </ControlButton>

        {showVolumeControl && (
          <Popover open={volumeOpen} onOpenChange={setVolumeOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={volumeControl.label}
                  className={cn(CONTROL_BUTTON_CLASS, CONTROL_ICON_CLASS, overlayButtonClass)}
                />
              }
            >
              <VolumeControlIcon aria-hidden />
            </PopoverTrigger>
            <PopoverContent
              container={portalContainer}
              side="top"
              align="start"
              glass
              className={cn(
                "w-auto items-center gap-2 p-2.5",
                // Same material as the settings popup beside it, so the two
                // control-bar popups read as one family.
                glassPanelClass({ overlay }),
              )}
            >
              <PopoverTitle className="sr-only">音量</PopoverTitle>
              <Slider
                value={volume}
                min={0}
                max={100}
                step={1}
                orientation="vertical"
                className={cn("h-32", compact && "h-20 [&_[data-base-ui-slider-control]]:min-h-20")}
                aria-label="音量"
                aria-valuetext={`${Math.round(volume)}%`}
                onValueChange={(nextValue) => {
                  onVolume(Number(Array.isArray(nextValue) ? nextValue[0] : nextValue));
                }}
              />
              <Separator className={cn("w-8", glassSeparatorClass({ overlay }))} />
              <Button
                type="button"
                variant={overlay ? "ghost" : isMuted ? "secondary" : "ghost"}
                size="icon-sm"
                className={cn(
                  "size-8",
                  CONTROL_ICON_CLASS,
                  overlay && "text-white/90 hover:bg-white/12 hover:text-white",
                  isMuted && glassOptionSelectedClass({ overlay }),
                )}
                aria-label={muteLabel}
                aria-pressed={isMuted}
                onClick={onToggleMute}
              >
                <VolumeX aria-hidden />
              </Button>
            </PopoverContent>
          </Popover>
        )}

        {showSecondaryControls && onToggleAudioOnly && (
          <ControlButton
            label={audioOnlyControl.label}
            variant={overlay ? "ghost" : audioOnly ? "secondary" : "ghost"}
            className={cn(overlayButtonClass, audioOnly && overlay && "bg-white/18 text-white")}
            disabled={disabled && !audioOnly}
            aria-pressed={audioOnlyControl.enabled}
            onClick={onToggleAudioOnly}
            tooltip={!compact}
          >
            <AudioOnlyControlIcon aria-hidden />
          </ControlButton>
        )}
      </div>

      {loadError && (
        <span
          className={cn(
            "min-w-0 max-w-28 truncate px-1 text-xs",
            overlay ? "text-red-200" : "text-destructive",
          )}
        >
          {loadError}
        </span>
      )}

      {showPlayerControlsCenterSlot(compact, fullscreen) && (
        <div className="flex min-w-0 flex-1 justify-center px-1">{centerSlot}</div>
      )}

      <div className="player-controls-actions ml-auto flex min-w-0 items-center gap-1 overflow-x-auto pl-1 max-md:overflow-visible">
        {hasStreamSettings &&
          (compact ? (
            <>
              <Button
                {...streamSettingsTriggerProps}
                aria-expanded={streamSettingsOpen}
                onClick={() => setStreamSettingsOpen((open) => !open)}
              >
                <Settings data-icon="inline-start" aria-hidden />
              </Button>
              <Drawer open={streamSettingsOpen} onOpenChange={setStreamSettingsOpen}>
                <DrawerContent
                  side={portrait ? "bottom" : "right"}
                  container={portalContainer}
                  glass
                  className={cn(
                    // Over video the drawer needs the darker tint; both
                    // contexts now supply their material through the helper,
                    // so `glass` is unconditional and only drops `bg-popover`.
                    glassPanelClass({ overlay }),
                  )}
                >
                  <DrawerTitle
                    className={cn(
                      "px-1 pb-1 text-xs font-medium text-muted-foreground",
                      glassMutedTextClass({ overlay }),
                    )}
                  >
                    播放设置
                  </DrawerTitle>
                  {streamSettingsBody}
                </DrawerContent>
              </Drawer>
            </>
          ) : (
            <Popover open={streamSettingsOpen} onOpenChange={setStreamSettingsOpen}>
              <PopoverTrigger
                openOnHover
                delay={120}
                closeDelay={180}
                render={
                  <Button {...streamSettingsTriggerProps}>
                    <Settings data-icon="inline-start" aria-hidden />
                  </Button>
                }
              />
              <PopoverContent
                container={portalContainer}
                side="top"
                align="end"
                collisionBoundary={
                  typeof document !== "undefined" ? document.documentElement : undefined
                }
                collisionPadding={{
                  top: 24,
                  right: 12,
                  bottom: 12,
                  left: 12,
                }}
                sticky
                glass
                className={cn(
                  "z-50 max-h-[var(--available-height,calc(100dvh-5rem))] w-56 max-md:w-[min(20rem,calc(100vw-1.5rem))] gap-0 overflow-y-auto p-1.5",
                  glassPanelClass({ overlay }),
                )}
              >
                <PopoverTitle
                  className={cn(
                    "px-2 py-1 text-xs font-medium text-muted-foreground max-md:py-0.5",
                    glassMutedTextClass({ overlay }),
                  )}
                >
                  播放设置
                </PopoverTitle>
                {streamSettingsBody}
              </PopoverContent>
            </Popover>
          ))}

        {showSecondaryControls && onToggleOsd && (
          <ControlButton
            label={danmakuControl.label}
            variant="ghost"
            className={overlayButtonClass}
            disabled={disabled}
            data-slot="danmaku-toggle"
            data-state={danmakuControl.enabled ? "on" : "off"}
            aria-pressed={danmakuControl.enabled}
            onClick={onToggleOsd}
            tooltip={!compact}
          >
            <DanmakuControlIcon aria-hidden />
          </ControlButton>
        )}
        {showSecondaryControls && asrVisible && onToggleAsr && (
          <Popover open={asrSettingsOpen} onOpenChange={setAsrSettingsOpen}>
            <PopoverTrigger
              openOnHover
              delay={120}
              closeDelay={180}
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    CONTROL_BUTTON_CLASS,
                    CONTROL_ICON_CLASS,
                    overlayButtonClass,
                    asrDisabled && "pointer-events-auto opacity-50",
                    asrOn && !overlay && "text-primary",
                  )}
                  aria-label={asrLabel}
                  aria-disabled={asrDisabled}
                  aria-pressed={asrOn}
                  onClick={asrDisabled ? undefined : onToggleAsr}
                >
                  {asrControl.icon === "spinner" ? (
                    <Spinner aria-hidden />
                  ) : asrControl.icon === "captions" ? (
                    <Captions data-icon="inline-start" aria-hidden />
                  ) : (
                    <CaptionsOff data-icon="inline-start" aria-hidden />
                  )}
                </Button>
              }
            />
            <PopoverContent
              container={portalContainer}
              side="top"
              align="end"
              collisionBoundary={
                typeof document !== "undefined" ? document.documentElement : undefined
              }
              collisionPadding={{ top: 24, right: 12, bottom: 12, left: 12 }}
              sticky
              glass
              className={cn("w-72", glassPanelClass({ overlay }))}
            >
              <div className="flex items-center justify-between gap-2">
                <PopoverTitle>字幕设置</PopoverTitle>
                {(asrSettingsPending || asrTranslationBusy) && (
                  <Spinner aria-label="正在更新字幕设置" />
                )}
              </div>
              {captionSettingsBody}
            </PopoverContent>
          </Popover>
        )}
        {showSidePanelControl && onToggleSidePanel && (
          <ControlButton
            label={resolvedSidePanelLabel}
            variant={overlay ? "ghost" : sidePanelOpen ? "secondary" : "ghost"}
            className={overlayButtonClass}
            aria-pressed={sidePanelOpen}
            onClick={onToggleSidePanel}
            tooltip={!compact}
          >
            {sidePanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </ControlButton>
        )}
        {showSecondaryControls && pictureInPictureSupported && onTogglePictureInPicture && (
          <ControlButton
            label={pictureInPictureActive ? "退出画中画" : "画中画"}
            className={overlayButtonClass}
            disabled={disabled || pictureInPictureDisabled}
            aria-pressed={pictureInPictureActive}
            onClick={onTogglePictureInPicture}
            tooltip={!compact}
          >
            <PictureInPicture2 />
          </ControlButton>
        )}
        <ControlButton
          label={fullscreenLabel}
          className={overlayButtonClass}
          disabled={disabled}
          aria-pressed={fullscreen}
          onClick={(event) => {
            if (event.detail > 0) event.currentTarget.blur();
            onToggleFullscreen();
          }}
          tooltip={!compact}
        >
          {fullscreen ? (
            <Minimize2 data-icon="inline-start" aria-hidden />
          ) : (
            <Maximize2 data-icon="inline-start" aria-hidden />
          )}
        </ControlButton>
      </div>
    </div>
  );
}
