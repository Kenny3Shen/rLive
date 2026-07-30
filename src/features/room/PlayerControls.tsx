import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  Captions,
  CaptionsOff,
  Check,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { lineLabel } from "@/lib/playUrl";
import { cn } from "@/lib/utils";

export type LocalCaptionControls = {
  enabled: boolean;
  pending: boolean;
  ready: boolean;
  onToggle: () => void;
};

export function danmakuControlPresentation(osdOn: boolean | undefined) {
  const enabled = Boolean(osdOn);
  return {
    enabled,
    label: enabled ? "关闭弹幕" : "开启弹幕",
    icon: enabled ? "captions" : "captions-off",
  } as const;
}

export type PlayerControlsProps = {
  paused: boolean;
  volume: number;
  muted?: boolean;
  sidePanelOpen: boolean;
  /** Changes with the responsive side-panel presentation (rail vs. drawer). */
  sidePanelLabel?: string;
  osdOn?: boolean;
  qualities: { quality: string }[];
  qualityIndex: number;
  lines: { url: string }[];
  lineIndex: number;
  fullscreen?: boolean;
  pictureInPictureSupported?: boolean;
  pictureInPictureActive?: boolean;
  pictureInPictureDisabled?: boolean;
  disabled?: boolean;
  /** Use when controls are rendered over the bottom edge of the video. */
  overlay?: boolean;
  /** Optional compact content centered between transport and room controls. */
  centerSlot?: ReactNode;
  /** Local Whisper caption controls, available for a live room player. */
  captions?: LocalCaptionControls;
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
  onToggleSidePanel: () => void;
  onToggleOsd?: () => void;
  onQualityChange: (index: number) => void;
  onLineChange: (index: number) => void;
  onTogglePictureInPicture?: () => void;
  onToggleFullscreen: () => void;
};

type ControlButtonProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "size"
> & {
  label: string;
  children: ReactNode;
};

function ControlButton({
  label,
  children,
  disabled,
  variant = "ghost",
  className,
  ...props
}: ControlButtonProps) {
  const button = (
    <Button
      {...props}
      variant={variant}
      size="icon-sm"
      disabled={disabled}
      aria-label={label}
      className={cn("max-md:size-11 max-md:touch-manipulation", className)}
    >
      {children}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Compact controls kept separate from the MSE player implementation. */
export function PlayerControls({
  paused,
  volume,
  muted = false,
  sidePanelOpen,
  sidePanelLabel,
  osdOn,
  qualities,
  qualityIndex,
  lines,
  lineIndex,
  fullscreen = false,
  pictureInPictureSupported = false,
  pictureInPictureActive = false,
  pictureInPictureDisabled = false,
  disabled = false,
  overlay = false,
  centerSlot,
  captions,
  onOverlayInteractionChange,
  refreshDisabled = disabled,
  loadError,
  onRefresh,
  onTogglePause,
  onVolume,
  onToggleMute,
  onToggleSidePanel,
  onToggleOsd,
  onQualityChange,
  onLineChange,
  onTogglePictureInPicture,
  onToggleFullscreen,
}: PlayerControlsProps) {
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [streamSettingsOpen, setStreamSettingsOpen] = useState(false);
  const [mobileOptionsOpen, setMobileOptionsOpen] = useState(false);
  const isMuted = muted || volume === 0;
  const volumeLabel = "调节音量";
  const muteLabel = isMuted ? "取消静音（M）" : "静音（M）";
  const overlayButtonClass = overlay
    ? "rounded-lg text-white/90 hover:bg-transparent hover:text-white aria-expanded:bg-transparent aria-expanded:text-white focus-visible:ring-white/70"
    : undefined;
  const overlayStreamSettingsContentClass = overlay
    ? "border border-white/10 bg-black/90 text-white shadow-xl"
    : undefined;
  const overlayStreamSettingsOptionClass = overlay
    ? "text-white hover:bg-white/12 hover:text-white data-highlighted:bg-white/12 data-highlighted:text-white data-selected:bg-white/18 data-selected:text-white data-selected:hover:bg-white/18 data-selected:data-highlighted:bg-white/18"
    : undefined;
  const overlayInteractionOpen = volumeOpen || streamSettingsOpen || mobileOptionsOpen;

  useEffect(() => {
    onOverlayInteractionChange?.(overlayInteractionOpen);
  }, [onOverlayInteractionChange, overlayInteractionOpen]);

  useEffect(
    () => () => {
      onOverlayInteractionChange?.(false);
    },
    [onOverlayInteractionChange],
  );

  useEffect(() => {
    if (!volumeOpen && !streamSettingsOpen && !mobileOptionsOpen) return;
    const closeOnAndroidBack = (event: Event) => {
      event.preventDefault();
      setVolumeOpen(false);
      setStreamSettingsOpen(false);
      setMobileOptionsOpen(false);
    };
    window.addEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
  }, [mobileOptionsOpen, streamSettingsOpen, volumeOpen]);

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
    lines.length > 0 && lines[lineIndex]
      ? `线路 ${lineLabel(lines[lineIndex].url, lineIndex)}`
      : null,
  ]
    .filter(Boolean)
    .join("，");
  const closeStreamSettings = () => setStreamSettingsOpen(false);
  const captionButtonLabel = captions?.pending
    ? "正在启动本地字幕"
    : captions?.enabled
      ? "关闭本地字幕"
      : captions?.ready
        ? "开启本地字幕"
        : "开启本地字幕（等待播放器音频）";
  const danmakuControl = danmakuControlPresentation(osdOn);
  const DanmakuControlIcon = danmakuControl.icon === "captions" ? Captions : CaptionsOff;
  const resolvedSidePanelLabel = sidePanelLabel ?? (sidePanelOpen ? "收起右侧栏" : "展开右侧栏");
  return (
    <div
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 px-1.5 py-1 max-md:justify-between",
        overlay
          ? "rounded-xl border border-white/10 bg-black/72 text-white shadow-[0_10px_30px_rgb(0_0_0_/_0.34)]"
          : "border-t border-border bg-card",
      )}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        {onRefresh && (
          <ControlButton
            label="刷新播放"
            className={cn(overlayButtonClass, "max-md:hidden")}
            disabled={refreshDisabled}
            onClick={onRefresh}
          >
            <RefreshCw />
          </ControlButton>
        )}
        <ControlButton
          label={paused ? "播放（Space / K）" : "暂停（Space / K）"}
          className={overlayButtonClass}
          disabled={disabled}
          onClick={onTogglePause}
        >
          {paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
        </ControlButton>

        <Popover onOpenChange={(open) => setVolumeOpen(open)}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={volumeLabel}
                className={cn("max-md:hidden", overlayButtonClass)}
              />
            }
          >
            <Volume2 />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className={cn(
              "w-auto p-3",
              overlay && "border border-white/10 bg-black/90 text-white shadow-xl",
            )}
          >
            <Slider
              value={volume}
              min={0}
              max={100}
              step={1}
              orientation="vertical"
              className="h-28"
              aria-label="音量"
              aria-valuetext={`${volume}%`}
              onValueChange={(nextValue) => {
                onVolume(Number(Array.isArray(nextValue) ? nextValue[0] : nextValue));
              }}
            />
          </PopoverContent>
        </Popover>

        <ControlButton
          label={muteLabel}
          className={overlayButtonClass}
          disabled={disabled}
          aria-pressed={isMuted}
          onClick={onToggleMute}
        >
          {isMuted ? <VolumeX /> : <Volume2 />}
        </ControlButton>
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

      <div className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto pl-1 max-md:overflow-visible">
        {hasStreamSettings && (
          <div className="hidden md:block">
            <Popover open={streamSettingsOpen} onOpenChange={setStreamSettingsOpen}>
              <PopoverTrigger
                openOnHover
                delay={120}
                closeDelay={180}
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={streamSettingsDisabled}
                    aria-label={
                      streamSettingsLabel ? `播放设置：${streamSettingsLabel}` : "播放设置"
                    }
                    className={cn("max-md:size-11 max-md:touch-manipulation", overlayButtonClass)}
                  />
                }
              >
                <Settings data-icon="inline-start" aria-hidden />
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="end"
                className={cn("w-56 gap-0 p-1.5", overlayStreamSettingsContentClass)}
              >
                <PopoverTitle
                  className={cn(
                    "px-2 py-1 text-xs font-medium text-muted-foreground",
                    overlay && "text-white/60",
                  )}
                >
                  播放设置
                </PopoverTitle>

                {qualities.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <span
                      className={cn(
                        "px-2 pt-1 text-xs text-muted-foreground",
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
                            "w-full justify-between max-md:h-11",
                            overlayStreamSettingsOptionClass,
                            overlay && selected && "bg-white/18 text-white",
                          )}
                          aria-pressed={selected}
                          onClick={() => {
                            onQualityChange(index);
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
                  <Separator className={cn("my-1", overlay && "bg-white/10")} />
                )}

                {lines.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <span
                      className={cn(
                        "px-2 pt-1 text-xs text-muted-foreground",
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
                            "w-full justify-between max-md:h-11",
                            overlayStreamSettingsOptionClass,
                            overlay && selected && "bg-white/18 text-white",
                          )}
                          aria-pressed={selected}
                          onClick={() => {
                            onLineChange(index);
                            closeStreamSettings();
                          }}
                        >
                          <span className="truncate">{lineLabel(line.url, index)}</span>
                          {selected && <Check data-icon="inline-end" aria-hidden />}
                        </Button>
                      );
                    })}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>
        )}

        {captions && (
          <div className="hidden md:block">
            <ControlButton
              label={captionButtonLabel}
              variant={overlay ? "ghost" : captions.enabled ? "secondary" : "ghost"}
              className={overlayButtonClass}
              disabled={disabled || captions.pending}
              aria-pressed={captions.enabled}
              aria-busy={captions.pending}
              onClick={captions.onToggle}
            >
              {captions.pending ? (
                <Spinner data-icon="inline-start" aria-hidden />
              ) : captions.enabled ? (
                <Captions data-icon="inline-start" aria-hidden />
              ) : (
                <CaptionsOff data-icon="inline-start" aria-hidden />
              )}
            </ControlButton>
          </div>
        )}

        <Popover open={mobileOptionsOpen} onOpenChange={setMobileOptionsOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="更多播放选项"
                className={cn("size-11 touch-manipulation md:hidden", overlayButtonClass)}
              />
            }
          >
            <MoreHorizontal data-icon="inline-start" aria-hidden />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            className={cn(
              "max-h-[min(26rem,calc(100dvh-5rem))] w-64 gap-1.5 overflow-y-auto p-1.5",
              overlayStreamSettingsContentClass,
            )}
          >
            <PopoverTitle
              className={cn(
                "px-2 py-1 text-xs font-medium text-muted-foreground",
                overlay && "text-white/60",
              )}
            >
              更多播放选项
            </PopoverTitle>

            {onRefresh && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn("h-11 w-full justify-start", overlayStreamSettingsOptionClass)}
                disabled={refreshDisabled}
                onClick={() => {
                  onRefresh();
                  setMobileOptionsOpen(false);
                }}
              >
                <RefreshCw data-icon="inline-start" aria-hidden />
                刷新播放
              </Button>
            )}

            {(qualities.length > 1 || lines.length > 1) && (
              <>
                {onRefresh && <Separator className={cn("my-1", overlay && "bg-white/10")} />}
                <div className="flex flex-col gap-0.5">
                  <span
                    className={cn(
                      "px-2 pt-1 text-xs text-muted-foreground",
                      overlay && "text-white/60",
                    )}
                  >
                    播放设置
                  </span>
                  {qualities.length > 1 &&
                    qualities.map((quality, index) => {
                      const selected = index === qualityIndex;
                      return (
                        <Button
                          key={`mobile-quality-${quality.quality}-${index}`}
                          type="button"
                          variant={overlay ? "ghost" : selected ? "secondary" : "ghost"}
                          size="sm"
                          className={cn(
                            "h-11 w-full justify-between",
                            overlayStreamSettingsOptionClass,
                            overlay && selected && "bg-white/18 text-white",
                          )}
                          disabled={disabled}
                          aria-pressed={selected}
                          onClick={() => {
                            onQualityChange(index);
                            setMobileOptionsOpen(false);
                          }}
                        >
                          <span className="truncate">清晰度 · {qualityLabel(index)}</span>
                          {selected && <Check data-icon="inline-end" aria-hidden />}
                        </Button>
                      );
                    })}
                  {lines.length > 1 &&
                    lines.map((line, index) => {
                      const selected = index === lineIndex;
                      return (
                        <Button
                          key={`mobile-line-${line.url}-${index}`}
                          type="button"
                          variant={overlay ? "ghost" : selected ? "secondary" : "ghost"}
                          size="sm"
                          className={cn(
                            "h-11 w-full justify-between",
                            overlayStreamSettingsOptionClass,
                            overlay && selected && "bg-white/18 text-white",
                          )}
                          disabled={disabled}
                          aria-pressed={selected}
                          onClick={() => {
                            onLineChange(index);
                            setMobileOptionsOpen(false);
                          }}
                        >
                          <span className="truncate">线路 · {lineLabel(line.url, index)}</span>
                          {selected && <Check data-icon="inline-end" aria-hidden />}
                        </Button>
                      );
                    })}
                </div>
              </>
            )}

            {captions && (
              <>
                {(onRefresh || qualities.length > 1 || lines.length > 1) && (
                  <Separator className={cn("my-1", overlay && "bg-white/10")} />
                )}
                <Button
                  type="button"
                  variant={overlay ? "ghost" : captions.enabled ? "secondary" : "ghost"}
                  size="sm"
                  className={cn(
                    "h-11 w-full justify-start",
                    overlayStreamSettingsOptionClass,
                    overlay && captions.enabled && "bg-white/18 text-white",
                  )}
                  disabled={disabled || captions.pending}
                  aria-pressed={captions.enabled}
                  aria-busy={captions.pending}
                  onClick={() => {
                    captions.onToggle();
                    setMobileOptionsOpen(false);
                  }}
                >
                  {captions.pending ? (
                    <Spinner data-icon="inline-start" aria-hidden />
                  ) : captions.enabled ? (
                    <Captions data-icon="inline-start" aria-hidden />
                  ) : (
                    <CaptionsOff data-icon="inline-start" aria-hidden />
                  )}
                  {captionButtonLabel}
                </Button>
              </>
            )}

            {pictureInPictureSupported && onTogglePictureInPicture && (
              <>
                {(onRefresh || qualities.length > 1 || lines.length > 1 || captions) && (
                  <Separator className={cn("my-1", overlay && "bg-white/10")} />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-11 w-full justify-start",
                    overlayStreamSettingsOptionClass,
                    overlay && pictureInPictureActive && "bg-white/18 text-white",
                  )}
                  disabled={disabled || pictureInPictureDisabled}
                  aria-pressed={pictureInPictureActive}
                  onClick={() => {
                    onTogglePictureInPicture();
                    setMobileOptionsOpen(false);
                  }}
                >
                  <PictureInPicture2 data-icon="inline-start" aria-hidden />
                  {pictureInPictureActive ? "退出画中画" : "画中画"}
                </Button>
              </>
            )}
          </PopoverContent>
        </Popover>

        {onToggleOsd && (
          <ControlButton
            label={danmakuControl.label}
            variant="ghost"
            className={overlayButtonClass}
            disabled={disabled}
            aria-pressed={danmakuControl.enabled}
            onClick={onToggleOsd}
          >
            <DanmakuControlIcon data-icon="inline-start" aria-hidden />
          </ControlButton>
        )}
        <ControlButton
          label={resolvedSidePanelLabel}
          variant={overlay ? "ghost" : sidePanelOpen ? "secondary" : "ghost"}
          className={overlayButtonClass}
          aria-pressed={sidePanelOpen}
          onClick={onToggleSidePanel}
        >
          {sidePanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </ControlButton>
        {pictureInPictureSupported && onTogglePictureInPicture && (
          <div className="hidden md:block">
            <ControlButton
              label={pictureInPictureActive ? "退出画中画" : "画中画"}
              className={overlayButtonClass}
              disabled={disabled || pictureInPictureDisabled}
              aria-pressed={pictureInPictureActive}
              onClick={onTogglePictureInPicture}
            >
              <PictureInPicture2 />
            </ControlButton>
          </div>
        )}
        <ControlButton
          label={fullscreen ? "退出全屏（F）" : "全屏（F）"}
          className={overlayButtonClass}
          disabled={disabled}
          aria-pressed={fullscreen}
          onClick={onToggleFullscreen}
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
