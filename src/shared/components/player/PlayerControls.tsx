import { useEffect, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import {
  Captions,
  CaptionsOff,
  Check,
  Expand,
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
  Shrink,
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
  glassTitleClass,
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
 * 移动端全屏已经暴露边缘滑动音量并隐藏了侧面板 chrome，
 * 因此控制条去掉这两个按钮保持舞台简洁。
 */
export function showPlayerVolumeControl(
  compact: boolean,
  portrait: boolean,
  fullscreen: boolean,
): boolean {
  if (compact && fullscreen) return false;
  return showSecondaryPlayerControls(compact, portrait);
}

/**
 * 侧面板开关只保留给移动端窗口化。桌面端这个位置改由「网页全屏」承担 ——
 * 后者除了收起右侧栏还会隐藏房间页的上下栏，单纯的收起按钮成了它的子集。
 */
export function showPlayerSidePanelControl(
  compact: boolean,
  portrait: boolean,
  fullscreen: boolean,
): boolean {
  if (!compact) return false;
  if (fullscreen) return false;
  return showSecondaryPlayerControls(compact, portrait);
}

/**
 * 网页全屏是桌面专属：它让出的是应用窗口内的上下栏与右侧栏，而移动端窗口化没有这些栏。
 * 原生全屏时舞台已独占窗口，再显示它只会是个空操作。
 */
export function showPlayerWebFullscreenControl(compact: boolean, fullscreen: boolean): boolean {
  return !compact && !fullscreen;
}

export function showPlayerControlsCenterSlot(compact: boolean, fullscreen: boolean): boolean {
  return !compact || fullscreen;
}

/**
 * 浮层 chrome 是否应为系统手势栏预留空间。
 *
 * `env(safe-area-inset-bottom)` 描述的是窗口而不是本元素。只有当控件真的位于
 * 窗口底边时 inset 才是真实的内边距：全屏状态，或播放器铺满视口直达底边时。
 * 竖屏房间的弹幕堆叠在画面之下，控件悬浮于视频底边之上，
 * 其下是面板而不是手势栏。在那里加内边距会把按钮抬高 inset 高度离开画面 ——
 * 这正是冷启动时出现（Android 上报 inset）、全屏往返后消失（WebView 使其塌缩为
 * 0）的那道缝隙：同一布局，同一 bug 的两种表现。
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
  /** 随响应式侧面板形态（侧栏 vs 抽屉）变化。 */
  sidePanelLabel?: string;
  /** 桌面端网页全屏：舞台占满应用窗口，但不进入原生全屏。 */
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
  qualities?: { quality: string }[];
  qualityIndex?: number;
  lines?: PlayUrl[];
  lineIndex?: number;
  fullscreen?: boolean;
  pictureInPictureSupported?: boolean;
  pictureInPictureActive?: boolean;
  pictureInPictureDisabled?: boolean;
  disabled?: boolean;
  /**
   * 当内容（竖屏弹幕面板、页面页脚）堆叠在播放器下方时设置，
   * 使控件不落在窗口底边，
   * 也就不必为系统手势栏预留空间。
   */
  stackedBelowPlayer?: boolean;
  /** 可选的紧凑内容，居中放置于传输控制与房间控制之间。 */
  centerSlot?: ReactNode;
  /** 可选的全宽媒体时间轴，渲染在传输控制行之上。 */
  timeline?: ReactNode;
  /** 追加到共享播放设置菜单的功能专属控件。 */
  playbackSettings?: ReactNode;
  playbackSettingsTitle?: string;
  playbackSettingsLabel?: string;
  playbackSettingsDisabled?: boolean;
  /**
   * 紧凑视口（竖屏手机 + 较矮横屏）。从标签中去掉仅限桌面的键盘提示，
   * 使 chrome 在小屏幕上读起来更短。
   */
  compact?: boolean;
  /**
   * 设置/音量 popover 的 Portal 目标。`:fullscreen` 祖先之下 top layer 拥有
   * 堆叠上下文，渲染进 <body> 的 portal 会堆在全屏元素之下 ——
   * 改为渲染进舞台内部，popover 才能保持在控制条上方。
   */
  portalContainer?: HTMLElement | React.RefObject<HTMLElement | null> | null;
  /**
   * 菜单内容经 portal 渲染在播放器舞台之外。菜单打开时告诉舞台，
   * 使其空闲计时器不能在菜单下面淡出。
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
  onToggleWebFullscreen?: () => void;
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
  /** 桌面悬停提示框。紧凑触摸布局下禁用。 */
  tooltip?: boolean;
  tooltipContainer?: HTMLElement | RefObject<HTMLElement | null> | null;
};

/**
 * 视频 chrome 的阅读距离比页面内按钮更远，因此图标比共享按钮默认值
 * （size-4）大一小档。
 *
 * 导出这三个是因为全屏顶部 HUD 在本控制条之外绘制自己的按钮；
 * 共享这些类使两层 chrome 的图标尺寸、命中区域和焦点处理不会漂移。
 */
export const PLAYER_CONTROL_ICON_CLASS = "[&_svg:not([class*='size-'])]:size-4.5";
/** 即使共享粗指针下限是 44px，播放器 chrome 也保持紧凑。 */
export const PLAYER_CONTROL_BUTTON_CLASS =
  "size-9 [@media(pointer:coarse)]:size-9! [@media(pointer:coarse)]:min-h-9! [@media(pointer:coarse)]:min-w-9! [@media(pointer:coarse)]:touch-manipulation";
/** 绘制在视频上的 chrome 按钮裁剪：遮罩上的白色图标。 */
export const PLAYER_OVERLAY_CONTROL_BUTTON_CLASS =
  "rounded-lg text-white/90 hover:bg-white/12 hover:text-white aria-expanded:bg-white/12 aria-expanded:text-white focus-ring-overlay drop-shadow-[0_1px_2px_rgb(0_0_0_/_0.65)]";
const CONTROL_ICON_CLASS = PLAYER_CONTROL_ICON_CLASS;
const CONTROL_BUTTON_CLASS = PLAYER_CONTROL_BUTTON_CLASS;
const CONTROL_GROUP_CLASS = "flex shrink-0 items-center gap-0.5";

function ControlButton({
  label,
  children,
  disabled,
  variant = "ghost",
  className,
  tooltip = true,
  tooltipContainer,
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
      <TooltipContent container={tooltipContainer}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** 与各功能媒体生命周期分离的共享 React 控件。 */
export function PlayerControls({
  paused,
  volume,
  muted = false,
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
  pictureInPictureSupported = false,
  pictureInPictureActive = false,
  pictureInPictureDisabled = false,
  disabled = false,
  stackedBelowPlayer = false,
  compact = false,
  centerSlot,
  timeline,
  playbackSettings,
  playbackSettingsTitle = "播放设置",
  playbackSettingsLabel,
  playbackSettingsDisabled,
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
  onToggleWebFullscreen,
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
  // 移动端设置以抽屉打开：竖屏为底部抽屉、横屏为右侧抽屉。共享 hook 在首次
  // 绘制和变化时从单一来源解析方向，使控件密度绝不会有渲染成一帧桌面尺寸
  // 才稳定下来的情况。
  const portrait = usePortraitOrientation();
  const showSecondaryControls = showSecondaryPlayerControls(compact, portrait);
  const showVolumeControl = showPlayerVolumeControl(compact, portrait, fullscreen);
  const showSidePanelControl = showPlayerSidePanelControl(compact, portrait, fullscreen);
  const showWebFullscreenControl = showPlayerWebFullscreenControl(compact, fullscreen);
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
  const overlayButtonClass = PLAYER_OVERLAY_CONTROL_BUTTON_CLASS;
  // 选项行来自共享玻璃模块，使播放器弹窗、设置抽屉与房间抽屉不会漂移。
  const overlayStreamSettingsOptionClass = glassOptionClass({ overlay: true });
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
    // Select 以下标作为取值。不要把这个内部取值（或上游纯数字标签）
    // 暴露在播放器 chrome 中。
    if (!label || /^(?:rate)?\d+$/i.test(label)) {
      return ["原画", "蓝光", "超清", "高清", "流畅", "标清"][index] ?? "可用清晰度";
    }
    return label;
  };

  const hasStreamSettings = qualities.length > 0 || lines.length > 0;
  const hasCustomPlaybackSettings = playbackSettings != null;
  const hasPlaybackSettings = hasStreamSettings || hasCustomPlaybackSettings;
  const streamSettingsDisabled =
    playbackSettingsDisabled ??
    (disabled || (!hasCustomPlaybackSettings && qualities.length <= 1 && lines.length <= 1));
  const streamSettingsLabel = [
    qualities.length > 0 ? `清晰度 ${qualityLabel(qualityIndex)}` : null,
    lines.length > 0 && lines[lineIndex] ? `线路 ${lineName(lines[lineIndex], lineIndex)}` : null,
  ]
    .filter(Boolean)
    .join("，");
  const closeStreamSettings = () => setStreamSettingsOpen(false);
  /**
   * 共享触发图标。桌面端这个按钮*就是* popover 触发器，兼任定位锚点 ——
   * 单独渲染锚点会让一个多余默认变体按钮留在控制条里。
   */
  const streamSettingsTriggerProps = {
    variant: "ghost",
    size: "icon-sm",
    disabled: streamSettingsDisabled,
    "aria-label":
      playbackSettingsLabel ??
      (streamSettingsLabel ? `播放设置：${streamSettingsLabel}` : playbackSettingsTitle),
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
  /** 流设置 popover/抽屉的共享主体。 */
  const streamSettingsBody = (
    <>
      {qualities.length > 0 && (
        <div className="flex flex-col gap-0.5 max-md:gap-px">
          <span
            className={cn(
              "px-2 pt-1 text-xs text-muted-foreground max-md:pt-0.5",
              glassMutedTextClass({ overlay: true }),
            )}
          >
            清晰度
          </span>
          {qualities.map((quality, index) => {
            const selected = index === qualityIndex;
            return (
              <Button
                key={`${quality.quality}-${index}`}
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full justify-between max-md:h-10",
                  overlayStreamSettingsOptionClass,
                  selected && glassOptionSelectedClass({ overlay: true }),
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
        <Separator className={cn("my-1 max-md:my-0.5", glassSeparatorClass({ overlay: true }))} />
      )}

      {lines.length > 0 && (
        <div className="flex flex-col gap-0.5 max-md:gap-px">
          <span
            className={cn(
              "px-2 pt-1 text-xs text-muted-foreground max-md:pt-0.5",
              glassMutedTextClass({ overlay: true }),
            )}
          >
            线路
          </span>
          {lines.map((line, index) => {
            const selected = index === lineIndex;
            return (
              <Button
                key={`${line.url}-${index}`}
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full justify-between max-md:h-10",
                  overlayStreamSettingsOptionClass,
                  selected && glassOptionSelectedClass({ overlay: true }),
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

      {hasStreamSettings && hasCustomPlaybackSettings && (
        <Separator className={cn("my-1 max-md:my-0.5", glassSeparatorClass({ overlay: true }))} />
      )}
      {playbackSettings}
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

      <Separator className={cn(glassSeparatorClass({ overlay: true }))} />

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

      <Separator className={cn(glassSeparatorClass({ overlay: true }))} />

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
            className="w-32 hover:bg-white/12 focus-ring-overlay"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            container={portalContainer}
            side="top"
            align="end"
            glass
            className={cn("max-h-64", glassPanelClass({ overlay: true }))}
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
            className="w-32 hover:bg-white/12 focus-ring-overlay"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            container={portalContainer}
            side="top"
            align="end"
            glass
            className={cn("max-h-64", glassPanelClass({ overlay: true }))}
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
        "flex min-w-0 shrink-0",
        timeline ? "flex-col items-stretch gap-0" : "items-center gap-1",
        compact && !timeline && "justify-between gap-0.5",
        // 向上渐隐入画面的遮罩，普通视频播放器绘制底部 chrome 的方式 —— 无顶边框、
        // 无模糊、无面板边缘。渐变铺满播放器每条边；安全区间距留在表面内部，
        // 绝不形成沟槽。底部 inset 仅当 chrome 真正位于窗口边缘时生效
        // （见 playerControlsAvoidSystemGestureBar）。额外的顶部内边距
        // 给渐变留出在第一个控件之前化解的空间。
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
        ),
      )}
    >
      {timeline && <div className="min-w-0 px-1 pt-1">{timeline}</div>}
      <div
        className={cn(
          timeline ? "flex min-w-0 w-full items-center gap-1" : "contents",
          timeline && compact && "justify-between gap-0.5",
        )}
      >
        <div className={CONTROL_GROUP_CLASS}>
          {onRefresh && (
            <ControlButton
              label="刷新播放"
              className={overlayButtonClass}
              tooltipContainer={portalContainer}
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
            tooltipContainer={portalContainer}
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
                  // 与其旁的设置弹窗相同材质，使两个控制条弹窗看起来属于同一家族。
                  glassPanelClass({ overlay: true }),
                )}
              >
                <PopoverTitle className="sr-only">音量</PopoverTitle>
                <Slider
                  value={volume}
                  min={0}
                  max={100}
                  step={1}
                  orientation="vertical"
                  className={cn("h-32", compact && "h-20 [&_[data-slot=slider-control]]:min-h-20")}
                  aria-label="音量"
                  aria-valuetext={`${Math.round(volume)}%`}
                  onValueChange={(nextValue) => {
                    onVolume(Number(Array.isArray(nextValue) ? nextValue[0] : nextValue));
                  }}
                />
                <Separator className={cn("w-8", glassSeparatorClass({ overlay: true }))} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "size-8",
                    CONTROL_ICON_CLASS,
                    "text-white/90 hover:bg-white/12 hover:text-white",
                    isMuted && glassOptionSelectedClass({ overlay: true }),
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
              variant="ghost"
              className={cn(overlayButtonClass, audioOnly && "bg-white/18 text-white")}
              tooltipContainer={portalContainer}
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
            className="min-w-0 max-w-28 truncate px-1 text-xs text-red-200"
          >
            {loadError}
          </span>
        )}

        {showPlayerControlsCenterSlot(compact, fullscreen) && (
          <div className="flex min-w-0 flex-1 justify-center px-1">{centerSlot}</div>
        )}

        <div className={cn(CONTROL_GROUP_CLASS, "ml-auto pl-1")}>
          {hasPlaybackSettings &&
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
                      // 视频之上抽屉需要更深色调；两种上下文现在都经由辅助函数提供材质，
                      // 因此 `glass` 是无条件的，只去掉 `bg-popover`。
                      glassPanelClass({ overlay: true }),
                    )}
                  >
                    <DrawerTitle className={cn("px-1 pb-1", glassTitleClass({ overlay: true }))}>
                      {playbackSettingsTitle}
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
                    "z-50 max-h-[var(--available-height,calc(100dvh-5rem))] gap-0 overflow-y-auto p-1.5",
                    hasCustomPlaybackSettings
                      ? "w-[min(24rem,calc(100vw-1.5rem))]"
                      : "w-56 max-md:w-[min(20rem,calc(100vw-1.5rem))]",
                    glassPanelClass({ overlay: true }),
                  )}
                >
                  <PopoverTitle
                    className={cn("px-2 py-1 max-md:py-0.5", glassTitleClass({ overlay: true }))}
                  >
                    {playbackSettingsTitle}
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
              tooltipContainer={portalContainer}
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
                className={cn("w-72", glassPanelClass({ overlay: true }))}
              >
                <div className="flex items-center justify-between gap-2 px-0.5">
                  <PopoverTitle className={glassTitleClass({ overlay: true })}>字幕设置</PopoverTitle>
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
              variant="ghost"
              className={overlayButtonClass}
              tooltipContainer={portalContainer}
              aria-pressed={sidePanelOpen}
              onClick={onToggleSidePanel}
              tooltip={!compact}
            >
              {sidePanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </ControlButton>
          )}
          {showWebFullscreenControl && onToggleWebFullscreen && (
            <ControlButton
              label={webFullscreen ? "退出网页全屏" : "网页全屏"}
              variant="ghost"
              className={overlayButtonClass}
              tooltipContainer={portalContainer}
              aria-pressed={webFullscreen}
              onClick={onToggleWebFullscreen}
              tooltip={!compact}
            >
              {webFullscreen ? <Shrink /> : <Expand />}
            </ControlButton>
          )}
          {showSecondaryControls && pictureInPictureSupported && onTogglePictureInPicture && (
            <ControlButton
              label={pictureInPictureActive ? "退出画中画" : "画中画"}
              className={overlayButtonClass}
              tooltipContainer={portalContainer}
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
            tooltipContainer={portalContainer}
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
    </div>
  );
}
