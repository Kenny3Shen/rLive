import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  Captions,
  CaptionsOff,
  Check,
  Headphones,
  Maximize2,
  MessageCircle,
  MessageCircleOff,
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
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
    icon: enabled ? "message-circle" : "message-circle-off",
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
  stallAutoSwitchEnabled?: boolean;
  fullscreen?: boolean;
  pictureInPictureSupported?: boolean;
  pictureInPictureActive?: boolean;
  pictureInPictureDisabled?: boolean;
  disabled?: boolean;
  /** Use when controls are rendered over the bottom edge of the video. */
  overlay?: boolean;
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
  onStallAutoSwitchEnabledChange?: (enabled: boolean) => void;
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
 */
const CONTROL_ICON_CLASS = "[&_svg:not([class*='size-'])]:size-4.5";
/** Player chrome stays compact even when the shared coarse-pointer floor is 44px. */
const CONTROL_BUTTON_CLASS =
  "size-9 [@media(pointer:coarse)]:size-9! [@media(pointer:coarse)]:min-h-9! [@media(pointer:coarse)]:min-w-9! [@media(pointer:coarse)]:touch-manipulation";

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
  stallAutoSwitchEnabled = true,
  fullscreen = false,
  pictureInPictureSupported = false,
  pictureInPictureActive = false,
  pictureInPictureDisabled = false,
  disabled = false,
  overlay = false,
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
  onStallAutoSwitchEnabledChange,
  onTogglePictureInPicture,
  onToggleFullscreen,
}: PlayerControlsProps) {
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [streamSettingsOpen, setStreamSettingsOpen] = useState(false);
  const [asrSettingsOpen, setAsrSettingsOpen] = useState(false);
  const [asrSettingsError, setAsrSettingsError] = useState<string | null>(null);
  // Mobile settings open as a drawer: bottom sheet in portrait, right side in
  // landscape. Track orientation so the drawer matches the current posture.
  const [portrait, setPortrait] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia("(orientation: portrait)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(orientation: portrait)");
    const update = () => setPortrait(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const showSecondaryControls = showSecondaryPlayerControls(compact, portrait);
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
  const overlayButtonClass = overlay
    ? "rounded-lg text-white/90 hover:bg-white/12 hover:text-white aria-expanded:bg-white/12 aria-expanded:text-white focus-visible:ring-white/70 drop-shadow-[0_1px_2px_rgb(0_0_0_/_0.65)]"
    : undefined;
  // The fill itself comes from `glass-surface-overlay`; this only carries the
  // border, text colour and shadow so it cannot override the glass material.
  const overlayStreamSettingsContentClass = overlay
    ? "border border-white/10 text-white shadow-xl"
    : undefined;
  const overlayStreamSettingsOptionClass = overlay
    ? "text-white hover:bg-white/12 hover:text-white data-highlighted:bg-white/12 data-highlighted:text-white data-selected:bg-white/18 data-selected:text-white data-selected:hover:bg-white/18 data-selected:data-highlighted:bg-white/18"
    : undefined;
  const overlayInteractionOpen = volumeOpen || streamSettingsOpen || asrSettingsOpen;

  useEffect(() => {
    onOverlayInteractionChange?.(overlayInteractionOpen);
  }, [onOverlayInteractionChange, overlayInteractionOpen]);

  useEffect(() => {
    if (!mobilePortrait) return;
    setVolumeOpen(false);
    setAsrSettingsOpen(false);
  }, [mobilePortrait]);

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
  const stallAutoSwitchAvailable = Boolean(onStallAutoSwitchEnabledChange);
  const streamSettingsDisabled =
    disabled || (!stallAutoSwitchAvailable && qualities.length <= 1 && lines.length <= 1);
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
    danmakuControl.icon === "message-circle" ? MessageCircle : MessageCircleOff;
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
              overlay && "text-white/60",
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
                  overlay && selected && "bg-white/18 text-white",
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
        <Separator className={cn("my-1 max-md:my-0.5", overlay && "bg-white/10")} />
      )}

      {lines.length > 0 && (
        <div className="flex flex-col gap-0.5 max-md:gap-px">
          <span
            className={cn(
              "px-2 pt-1 text-xs text-muted-foreground max-md:pt-0.5",
              overlay && "text-white/60",
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
                  overlay && selected && "bg-white/18 text-white",
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

      {stallAutoSwitchAvailable && (
        <>
          <Separator className={cn("my-1 max-md:my-0.5", overlay && "bg-white/10")} />
          <Field orientation="horizontal" className="px-2 py-1.5">
            <FieldLabel htmlFor="player-stall-auto-switch">卡顿自动换线</FieldLabel>
            <Switch
              id="player-stall-auto-switch"
              size="sm"
              checked={stallAutoSwitchEnabled}
              onCheckedChange={onStallAutoSwitchEnabledChange}
            />
          </Field>
        </>
      )}
    </>
  );
  const captionSettingsBody = (
    <FieldGroup className="gap-3">
      <Field
        orientation="horizontal"
        data-disabled={asrSettingsPending || !onAsrSpeakerDiarizationEnabledChange || undefined}
      >
        <FieldContent>
          <FieldLabel htmlFor="player-caption-speaker-diarization">说话人区分</FieldLabel>
          <FieldDescription className={cn("text-xs", overlay && "text-white/60")}>
            为稳定字幕添加匿名编号
          </FieldDescription>
        </FieldContent>
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

      <Separator className={cn(overlay && "bg-white/10")} />

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="player-caption-translation">字幕翻译</FieldLabel>
          <FieldDescription className={cn("text-xs", overlay && "text-white/60")}>
            稳定字幕将发送到 Google 翻译
          </FieldDescription>
        </FieldContent>
        <Switch
          id="player-caption-translation"
          size="sm"
          checked={asrTranslationEnabled}
          disabled={!onAsrTranslationEnabledChange}
          onCheckedChange={onAsrTranslationEnabledChange}
        />
      </Field>

      <Separator className={cn(overlay && "bg-white/10")} />

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
            className={cn(
              "max-h-64",
              overlay && "glass-surface-overlay border-white/10 text-white",
            )}
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
            className={cn(
              "max-h-64",
              overlay && "glass-surface-overlay border-white/10 text-white",
            )}
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
          ? // The material reaches every player edge; safe-area spacing stays
            // inside the surface so it never creates a visible gutter.
            cn(
              "glass-surface-overlay border-t border-white/12 bg-transparent pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.375rem,env(safe-area-inset-left))] text-white",
              compact
                ? "pt-px pb-[max(1px,env(safe-area-inset-bottom))]"
                : "pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]",
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

        {showSecondaryControls && (
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
                overlay ? "glass-surface-overlay" : "glass-surface",
                overlay && "border border-white/10 text-white shadow-xl",
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
                aria-valuetext={`${volume}%`}
                onValueChange={(nextValue) => {
                  onVolume(Number(Array.isArray(nextValue) ? nextValue[0] : nextValue));
                }}
              />
              <Separator className={cn("w-8", overlay && "bg-white/10")} />
              <Button
                type="button"
                variant={overlay ? "ghost" : isMuted ? "secondary" : "ghost"}
                size="icon-sm"
                className={cn(
                  "size-8",
                  CONTROL_ICON_CLASS,
                  overlay && "text-white/90 hover:bg-white/12 hover:text-white",
                  isMuted && overlay && "bg-white/18 text-white",
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

      <div className="hidden min-w-0 flex-1 justify-center px-1 md:flex">{centerSlot}</div>

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
                  glass={!overlay}
                  className={cn(
                    // Over video the drawer needs the darker tint, so it takes
                    // the overlay material instead of the drawer's own `glass`.
                    overlay && "glass-surface-overlay",
                    overlayStreamSettingsContentClass,
                  )}
                >
                  <DrawerTitle
                    className={cn(
                      "px-1 pb-1 text-xs font-medium text-muted-foreground",
                      overlay && "text-white/60",
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
                  overlay ? "glass-surface-overlay" : "glass-surface",
                  overlayStreamSettingsContentClass,
                )}
              >
                <PopoverTitle
                  className={cn(
                    "px-2 py-1 text-xs font-medium text-muted-foreground max-md:py-0.5",
                    overlay && "text-white/60",
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
            aria-pressed={danmakuControl.enabled}
            onClick={onToggleOsd}
            tooltip={!compact}
          >
            <DanmakuControlIcon data-icon="inline-start" aria-hidden />
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
              className={cn(
                "w-72",
                overlay ? "glass-surface-overlay" : "glass-surface",
                overlayStreamSettingsContentClass,
              )}
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
        {showSecondaryControls && onToggleSidePanel && (
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
          onClick={onToggleFullscreen}
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
