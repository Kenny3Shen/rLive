import type { ComponentProps, ReactNode } from "react";
import {
  Captions,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { lineLabel } from "@/lib/playUrl";

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
    <Button
      {...props}
      variant={variant}
      size="icon-sm"
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );

  if (disabled) return button;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button {...props} variant={variant} size="icon-sm" aria-label={label} />}
      >
        {children}
      </TooltipTrigger>
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
  osdOn,
  qualities,
  qualityIndex,
  lines,
  lineIndex,
  fullscreen = false,
  disabled = false,
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
  const isMuted = muted || volume === 0;
  const volumeLabel = "调节音量";
  const muteLabel = isMuted ? "取消静音" : "静音";

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
    <div className="flex shrink-0 items-center gap-1 border-t border-border bg-card px-2 py-1.5">
      <div className="flex shrink-0 items-center gap-1">
        {onRefresh && (
          <ControlButton label="刷新播放" disabled={refreshDisabled} onClick={onRefresh}>
            <RefreshCw />
          </ControlButton>
        )}
        <ControlButton label={paused ? "播放" : "暂停"} disabled={disabled} onClick={onTogglePause}>
          {paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
        </ControlButton>

        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={volumeLabel}
                title={volumeLabel}
              />
            }
          >
            <Volume2 />
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-auto p-3">
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
          disabled={disabled}
          aria-pressed={isMuted}
          onClick={onToggleMute}
        >
          {isMuted ? <VolumeX /> : <Volume2 />}
        </ControlButton>
      </div>

      {loadError && (
        <span className="min-w-0 max-w-40 truncate px-1 text-xs text-destructive" title={loadError}>
          {loadError}
        </span>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-2 overflow-x-auto pl-2">
        {qualities.length > 0 && (
          <Select
            value={String(qualityIndex)}
            disabled={disabled || qualities.length <= 1}
            onValueChange={(value) => {
              if (value != null) onQualityChange(Number(value));
            }}
          >
            <SelectTrigger size="sm" className="w-28 shrink-0" aria-label="清晰度">
              <SelectValue>
                {(value) => {
                  const index = typeof value === "string" ? Number(value) : -1;
                  return index >= 0 ? `清晰度 · ${qualityLabel(index)}` : "清晰度";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent side="top" align="end">
              <SelectGroup>
                {qualities.map((quality, index) => (
                  <SelectItem key={`${quality.quality}-${index}`} value={String(index)}>
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
            onValueChange={(value) => {
              if (value != null) onLineChange(Number(value));
            }}
          >
            <SelectTrigger size="sm" className="w-44 shrink-0" aria-label="线路">
              <SelectValue>
                {(value) => {
                  const index = typeof value === "string" ? Number(value) : -1;
                  return index >= 0 && lines[index]
                    ? `线路 · ${lineLabel(lines[index].url, index)}`
                    : "线路";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent side="top" align="end">
              <SelectGroup>
                {lines.map((line, index) => (
                  <SelectItem key={`${line.url}-${index}`} value={String(index)}>
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
            variant={osdOn ? "secondary" : "ghost"}
            disabled={disabled}
            aria-pressed={osdOn}
            onClick={onToggleOsd}
          >
            <Captions />
          </ControlButton>
        )}
        <ControlButton
          label={sidePanelOpen ? "收起右侧栏" : "展开右侧栏"}
          variant={sidePanelOpen ? "secondary" : "ghost"}
          disabled={disabled}
          aria-pressed={sidePanelOpen}
          onClick={onToggleSidePanel}
        >
          {sidePanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </ControlButton>
        <ControlButton
          label={fullscreen ? "退出全屏" : "全屏"}
          disabled={disabled}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
        </ControlButton>
      </div>
    </div>
  );
}
