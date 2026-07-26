import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  Captions,
  CaptionsOff,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  RefreshCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { lineLabel } from "@/lib/playUrl";
import { cn } from "@/lib/utils";

export type PlayerControlsProps = {
  paused: boolean;
  volume: number;
  muted?: boolean;
  sidePanelOpen: boolean;
  osdOn?: boolean;
  qualities: { quality: string }[];
  qualityIndex: number;
  lines: { url: string }[];
  lineIndex: number;
  fullscreen?: boolean;
  disabled?: boolean;
  /** Use when controls are rendered over the bottom edge of the video. */
  overlay?: boolean;
  /** Optional compact content centered between transport and room controls. */
  centerSlot?: ReactNode;
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
  ...props
}: ControlButtonProps) {
  const button = (
    <Button {...props} variant={variant} size="icon-sm" disabled={disabled} aria-label={label}>
      {children}
    </Button>
  );

  return button;
}

/** Compact controls kept separate from the MSE player implementation. */
export function PlayerControls({
  paused,
  volume,
  muted = false,
  sidePanelOpen,
  osdOn,
  qualities,
  qualityIndex,
  lines,
  lineIndex,
  fullscreen = false,
  disabled = false,
  overlay = false,
  centerSlot,
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
  onToggleFullscreen,
}: PlayerControlsProps) {
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const isMuted = muted || volume === 0;
  const volumeLabel = "调节音量";
  const muteLabel = isMuted ? "取消静音" : "静音";
  const overlayButtonClass = overlay
    ? "rounded-lg text-white/90 hover:bg-white/12 hover:text-white aria-expanded:bg-white/14 aria-expanded:text-white focus-visible:ring-white/70"
    : undefined;
  const overlaySelectTriggerClass = overlay
    ? "rounded-lg border border-white/10 bg-white/[0.055] px-2 text-xs font-medium text-white/90 hover:bg-white/12 hover:text-white aria-expanded:bg-white/14 aria-expanded:text-white data-placeholder:text-white/70 focus-visible:ring-white/70 [&_svg]:text-white/75"
    : undefined;
  const overlaySelectContentClass = overlay
    ? "border border-white/10 bg-black/90 text-white shadow-xl"
    : undefined;
  const overlaySelectItemClass = overlay
    ? "text-white hover:bg-white/12 hover:text-white data-highlighted:bg-white/12 data-highlighted:text-white data-selected:bg-white/18 data-selected:text-white data-selected:hover:bg-white/18 data-selected:data-highlighted:bg-white/18"
    : undefined;
  const overlayInteractionOpen = volumeOpen || qualityOpen || lineOpen;

  useEffect(() => {
    onOverlayInteractionChange?.(overlayInteractionOpen);
  }, [onOverlayInteractionChange, overlayInteractionOpen]);

  useEffect(
    () => () => {
      onOverlayInteractionChange?.(false);
    },
    [onOverlayInteractionChange],
  );

  const qualityLabel = (index: number) => {
    const label = qualities[index]?.quality?.trim();
    // The Select stores its index as the value. Do not expose that internal
    // value (or an upstream numeric-only label) in the player chrome.
    if (!label || /^(?:rate)?\d+$/i.test(label)) {
      return ["原画", "蓝光", "超清", "高清", "流畅", "标清"][index] ?? "可用清晰度";
    }
    return label;
  };

  return (
    <div
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 px-1.5 py-1",
        overlay
          ? "rounded-xl border border-white/10 bg-black/72 text-white shadow-[0_10px_30px_rgb(0_0_0_/_0.34)]"
          : "border-t border-border bg-card",
      )}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        {onRefresh && (
          <ControlButton
            label="刷新播放"
            className={cn(overlayButtonClass, "max-sm:hidden")}
            disabled={refreshDisabled}
            onClick={onRefresh}
          >
            <RefreshCw />
          </ControlButton>
        )}
        <ControlButton
          label={paused ? "播放" : "暂停"}
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
                className={cn(overlayButtonClass, "max-sm:hidden")}
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

      <div className="flex min-w-0 flex-1 justify-center px-1">{centerSlot}</div>

      <div className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto pl-1">
        {qualities.length > 0 && (
          <Select
            value={String(qualityIndex)}
            disabled={disabled || qualities.length <= 1}
            onOpenChange={(open) => setQualityOpen(open)}
            onValueChange={(value) => {
              if (value != null) onQualityChange(Number(value));
            }}
          >
            <SelectTrigger
              size="sm"
              className={cn("w-auto max-w-24 shrink-0", overlaySelectTriggerClass)}
              aria-label="清晰度"
            >
              <SelectValue>
                {(value) => {
                  const index = typeof value === "string" ? Number(value) : -1;
                  return index >= 0 ? qualityLabel(index) : "清晰度";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent side="top" align="end" className={overlaySelectContentClass}>
              <SelectGroup>
                {qualities.map((quality, index) => (
                  <SelectItem
                    key={`${quality.quality}-${index}`}
                    value={String(index)}
                    className={overlaySelectItemClass}
                  >
                    {qualityLabel(index)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}

        {lines.length > 0 && (
          <Select
            value={String(lineIndex)}
            disabled={disabled || lines.length <= 1}
            onOpenChange={(open) => setLineOpen(open)}
            onValueChange={(value) => {
              if (value != null) onLineChange(Number(value));
            }}
          >
            <SelectTrigger
              size="sm"
              className={cn("w-auto max-w-24 shrink-0", overlaySelectTriggerClass)}
              aria-label="线路"
            >
              <SelectValue>
                {(value) => {
                  const index = typeof value === "string" ? Number(value) : -1;
                  return index >= 0 && lines[index] ? lineLabel(lines[index].url, index) : "线路";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent side="top" align="end" className={overlaySelectContentClass}>
              <SelectGroup>
                {lines.map((line, index) => (
                  <SelectItem
                    key={`${line.url}-${index}`}
                    value={String(index)}
                    className={overlaySelectItemClass}
                  >
                    {lineLabel(line.url, index)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}

        {onToggleOsd && (
          <ControlButton
            label={osdOn ? "关闭弹幕" : "开启弹幕"}
            variant={overlay ? "ghost" : osdOn ? "secondary" : "ghost"}
            className={cn(
              overlayButtonClass,
              overlay && osdOn && "bg-white/12 text-white",
              "max-[360px]:hidden",
            )}
            disabled={disabled}
            aria-pressed={osdOn}
            onClick={onToggleOsd}
          >
            {osdOn ? <CaptionsOff /> : <Captions />}
          </ControlButton>
        )}
        <ControlButton
          label={sidePanelOpen ? "收起右侧栏" : "展开右侧栏"}
          variant={overlay ? "ghost" : sidePanelOpen ? "secondary" : "ghost"}
          className={cn(overlayButtonClass, overlay && sidePanelOpen && "bg-white/12 text-white")}
          disabled={disabled}
          aria-pressed={sidePanelOpen}
          onClick={onToggleSidePanel}
        >
          {sidePanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </ControlButton>
        <ControlButton
          label={fullscreen ? "退出全屏" : "全屏"}
          className={cn(overlayButtonClass, overlay && fullscreen && "bg-white/16 text-white")}
          disabled={disabled}
          aria-pressed={fullscreen}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
        </ControlButton>
      </div>
    </div>
  );
}
