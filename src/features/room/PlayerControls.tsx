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
  onToggleSidePanel,
  onToggleOsd,
  onQualityChange,
  onLineChange,
  onToggleFullscreen,
}: PlayerControlsProps) {
  const volumeLabel = muted || volume === 0 ? "音量（已静音）" : "调节音量";

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border bg-card px-2 py-1.5">
      {onRefresh && (
        <ControlButton label="刷新播放" disabled={refreshDisabled} onClick={onRefresh}>
          <RefreshCw />
        </ControlButton>
      )}
      <ControlButton label={paused ? "播放" : "暂停"} disabled={disabled} onClick={onTogglePause}>
        {paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
      </ControlButton>

      {loadError && (
        <span className="min-w-0 max-w-40 truncate px-1 text-xs text-destructive" title={loadError}>
          {loadError}
        </span>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-2 overflow-x-auto pl-2">
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
            {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
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

        {qualities.length > 0 && (
          <Select
            value={String(qualityIndex)}
            disabled={disabled || qualities.length <= 1}
            onValueChange={(value) => {
              if (value != null) onQualityChange(Number(value));
            }}
          >
            <SelectTrigger size="sm" className="w-20 shrink-0" aria-label="清晰度">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top" align="end">
              <SelectGroup>
                {qualities.map((quality, index) => (
                  <SelectItem key={`${quality.quality}-${index}`} value={String(index)}>
                    {quality.quality}
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
            <SelectTrigger size="sm" className="w-28 shrink-0" aria-label="线路">
              <SelectValue />
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
            label={osdOn ? "关闭飘屏" : "开启飘屏"}
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
