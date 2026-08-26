import { Clock3, RotateCcw, Wand2 } from "lucide-react";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToolActiveDot } from "@/shared/components/player/ToolActiveDot";
import {
  useMultiRoomLiveSyncRegistry,
  useMultiRoomLiveSyncStatus,
  useMultiRoomLiveSyncSummary,
} from "./MultiRoomLiveSyncProvider";
import {
  LIVE_SYNC_OFFSET_MAX_SECONDS,
  LIVE_SYNC_OFFSET_MIN_SECONDS,
  LIVE_SYNC_OFFSET_STEP_SECONDS,
  type LiveSyncMode,
} from "./liveSync";
import { liveSyncFeedStatusText } from "./liveSyncRegistry";
import { useMultiRoomStore, type MultiRoomEntry } from "./multiRoomStore";

const MODE_LABELS: Record<LiveSyncMode, string> = {
  off: "关闭",
  manual: "手动",
  auto: "自动",
};

const MODE_HINTS: Record<LiveSyncMode, string> = {
  off: "各路各自贴近直播边缘，延迟互不相干。",
  manual: "每路按设定秒数延后，任何平台都可用。",
  auto: "用各路自身时钟对齐同一时刻；HLS 精确，FLV 为估算。",
};

function SyncFeedField({ room, mainSlot }: { room: MultiRoomEntry; mainSlot: boolean }) {
  const labelId = useId();
  const offset = useMultiRoomStore((state) => state.syncOffsets[room.key] ?? 0);
  const setSyncOffset = useMultiRoomStore((state) => state.setSyncOffset);
  const status = useMultiRoomLiveSyncStatus(room.key);

  return (
    <Field className="gap-1.5">
      <FieldTitle className="w-full">
        {mainSlot && (
          <Badge variant="outline" className="shrink-0">
            主画面
          </Badge>
        )}
        <span id={labelId} className="min-w-0 flex-1 truncate text-xs">
          {room.userName || room.title}
        </span>
      </FieldTitle>
      <div className="flex items-center gap-2">
        <Slider
          aria-labelledby={labelId}
          value={offset}
          min={LIVE_SYNC_OFFSET_MIN_SECONDS}
          max={LIVE_SYNC_OFFSET_MAX_SECONDS}
          step={LIVE_SYNC_OFFSET_STEP_SECONDS}
          onValueChange={(value) => {
            const seconds = Number(value);
            if (Number.isFinite(seconds)) setSyncOffset(room.key, seconds);
          }}
        />
        <Badge variant="secondary" className="min-w-14 justify-center tabular-nums">
          {offset > 0 ? "+" : ""}
          {offset.toFixed(1)}s
        </Badge>
      </div>
      {/* 只在流上报出数值之后显示：四行"等待中"
          只会在播放器尚未启动时把滑杆彼此推开。 */}
      {status?.holdSeconds != null && (
        <FieldDescription className="text-xs">{liveSyncFeedStatusText(status)}</FieldDescription>
      )}
    </Field>
  );
}

/** 覆盖整个网格的直播时钟对齐控制面板。 */
export function MultiRoomSyncControl({
  rooms,
  mainKey,
}: {
  rooms: readonly MultiRoomEntry[];
  mainKey: string | null;
}) {
  const syncMode = useMultiRoomStore((state) => state.syncMode);
  const setSyncMode = useMultiRoomStore((state) => state.setSyncMode);
  const applySyncOffsets = useMultiRoomStore((state) => state.applySyncOffsets);
  const resetSyncOffsets = useMultiRoomStore((state) => state.resetSyncOffsets);
  const registry = useMultiRoomLiveSyncRegistry();
  const summary = useMultiRoomLiveSyncSummary();
  const active = syncMode !== "off";
  const label = active
    ? `时钟同步：${MODE_LABELS[syncMode]}${
        summary.targetLatencySeconds == null
          ? ""
          : `（延后 ${summary.targetLatencySeconds.toFixed(1)}s）`
      }`
    : "时钟同步";

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant={active ? "secondary" : "ghost"}
                  size="icon-sm"
                  aria-label={label}
                  aria-pressed={active}
                  disabled={rooms.length === 0}
                />
              }
            />
          }
        >
          <span className="relative inline-flex">
            <Clock3 data-icon="inline-start" aria-hidden />
            {active && <ToolActiveDot />}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={12}
        className="max-h-[calc(100vh-4rem)] overflow-y-auto"
      >
        <div className="flex items-center justify-between gap-2 px-0.5">
          <PopoverTitle>时钟同步</PopoverTitle>
          {summary.targetLatencySeconds != null && (
            <Badge variant="secondary" className="tabular-nums">
              延后 {summary.targetLatencySeconds.toFixed(1)}s
            </Badge>
          )}
        </div>
        <ToggleGroup
          value={[syncMode]}
          spacing={0}
          variant="outline"
          size="sm"
          aria-label="同步方式"
          className="grid w-full grid-cols-3"
          onValueChange={(value) => {
            const next = value[0];
            if (next === "off" || next === "manual" || next === "auto") setSyncMode(next);
          }}
        >
          <ToggleGroupItem value="off">关闭</ToggleGroupItem>
          <ToggleGroupItem value="manual">手动</ToggleGroupItem>
          <ToggleGroupItem value="auto">自动</ToggleGroupItem>
        </ToggleGroup>
        <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">
          {MODE_HINTS[syncMode]}
        </p>

        {active && (
          <>
            <Separator />
            <FieldGroup className="gap-3">
              {rooms.map((room) => (
                <SyncFeedField key={room.key} room={room} mainSlot={room.key === mainKey} />
              ))}
            </FieldGroup>
            <div className="flex items-center gap-1.5">
              {syncMode === "manual" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={!registry || summary.activeCount === 0}
                  onClick={() => {
                    const offsets = registry?.computeAlignOffsets(Date.now());
                    if (offsets) applySyncOffsets(offsets);
                  }}
                >
                  <Wand2 data-icon="inline-start" aria-hidden />
                  按最慢画面对齐
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={resetSyncOffsets}
              >
                <RotateCcw data-icon="inline-start" aria-hidden />
                重置偏移
              </Button>
            </div>
            <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">
              只能对齐到秒级；跨平台的固定偏差用偏移微调修正，切换方式会重建各路播放器。
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
