import {
  Pause,
  Play,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  MessageSquareText,
  Captions,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { lineLabel } from "@/lib/playUrl";
import { cn } from "@/lib/utils";

export type PlayerControlsProps = {
  paused: boolean;
  volume: number;
  muted?: boolean;
  danmakuOn: boolean;
  osdOn?: boolean;
  qualities: { quality: string }[];
  qualityIndex: number;
  lines: { url: string }[];
  lineIndex: number;
  fullscreen?: boolean;
  disabled?: boolean;
  loadError?: string | null;
  onTogglePause: () => void;
  onVolume: (v: number) => void;
  onToggleMute?: () => void;
  onToggleDanmaku: () => void;
  onToggleOsd?: () => void;
  onQualityChange: (index: number) => void;
  onLineChange: (index: number) => void;
  onToggleFullscreen: () => void;
};

const selectClass =
  "h-7 max-w-[10rem] rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

export function PlayerControls({
  paused,
  volume,
  muted = false,
  danmakuOn,
  osdOn,
  qualities,
  qualityIndex,
  lines,
  lineIndex,
  fullscreen = false,
  disabled = false,
  loadError,
  onTogglePause,
  onVolume,
  onToggleMute,
  onToggleDanmaku,
  onToggleOsd,
  onQualityChange,
  onLineChange,
  onToggleFullscreen,
}: PlayerControlsProps) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border bg-card px-2 py-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        title={paused ? "播放" : "暂停"}
        disabled={disabled}
        onClick={onTogglePause}
      >
        {paused ? (
          <Play className="fill-current" />
        ) : (
          <Pause className="fill-current" />
        )}
      </Button>

      {onToggleMute && (
        <Button
          variant="ghost"
          size="icon-sm"
          title={muted || volume === 0 ? "取消静音" : "静音"}
          disabled={disabled}
          onClick={onToggleMute}
        >
          {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
        </Button>
      )}
      <input
        type="range"
        min={0}
        max={100}
        value={volume}
        disabled={disabled}
        onChange={(e) => onVolume(Number(e.target.value))}
        className="w-24 accent-primary disabled:opacity-50"
        aria-label="音量"
      />

      <Separator orientation="vertical" className="mx-1 h-4" />

      <Button
        variant={danmakuOn ? "secondary" : "ghost"}
        size="sm"
        disabled={disabled}
        onClick={onToggleDanmaku}
      >
        <MessageSquareText data-icon="inline-start" />
        弹幕
      </Button>
      {onToggleOsd != null && (
        <Button
          variant={osdOn ? "secondary" : "ghost"}
          size="sm"
          disabled={disabled}
          onClick={onToggleOsd}
        >
          <Captions data-icon="inline-start" />
          飘屏
        </Button>
      )}

      {qualities.length > 0 && (
        <label className="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
          <span className="sr-only sm:not-sr-only">清晰度</span>
          <select
            value={qualityIndex}
            disabled={qualities.length <= 1}
            onChange={(e) => onQualityChange(Number(e.target.value))}
            className={selectClass}
            aria-label="清晰度"
          >
            {qualities.map((q, i) => (
              <option key={`${q.quality}-${i}`} value={i}>
                {q.quality}
              </option>
            ))}
          </select>
        </label>
      )}

      {lines.length > 0 && (
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="sr-only sm:not-sr-only">线路</span>
          <select
            value={lineIndex}
            disabled={lines.length <= 1}
            onChange={(e) => onLineChange(Number(e.target.value))}
            className={cn(selectClass, "max-w-[14rem]")}
            aria-label="线路"
          >
            {lines.map((u, i) => (
              <option key={`${u.url}-${i}`} value={i}>
                {lineLabel(u.url, i)}
              </option>
            ))}
          </select>
        </label>
      )}

      {loadError && (
        <span className="max-w-[12rem] truncate text-xs text-red-500" title={loadError}>
          {loadError}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title={fullscreen ? "退出全屏" : "全屏"}
          disabled={disabled}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
        </Button>
      </div>
    </div>
  );
}
