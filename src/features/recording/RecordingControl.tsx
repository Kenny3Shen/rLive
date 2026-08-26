import { useEffect, useId, useState } from "react";
import { CircleDot, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { glassPanelClass, glassTitleClass } from "@/shared/components/player/glassSurface";
import { ToolActiveDot } from "@/shared/components/player/ToolActiveDot";
import {
  RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT,
  useSettingsStore,
} from "@/shared/stores/settingsStore";
import {
  resolveRecordingControlOptions,
  useRecordingController,
  type RecordingContext,
  type RecordingStartOptions,
} from "./recording";

type RecordingControlProps = {
  context: RecordingContext | null;
  className?: string;
  disabled?: boolean;
};

/**
 * 直播房间与 IPTV 共享的唯一标题栏录制入口。开始时打开与房间工具（定时关闭）
 * 相同的玻璃选项盒；停止保持一键保存动作。
 */
export function RecordingControl({ context, className, disabled = false }: RecordingControlProps) {
  const controller = useRecordingController(context);
  const defaultIncludeDanmaku = useSettingsStore((state) => state.recordingIncludeDanmaku);
  const [open, setOpen] = useState(false);
  const [overrides, setOverrides] = useState<RecordingStartOptions>({});
  // 新任务的后台延续始终开启；下方的开关只是让这一次会话退出后台延续，
  // 背后没有存储的偏好设置。
  const { includeDanmaku, continueOnLeave } = resolveRecordingControlOptions(
    {
      includeDanmaku: defaultIncludeDanmaku,
      continueOnLeave: RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT,
    },
    overrides,
  );
  const danmakuSwitchId = useId();
  const continueSwitchId = useId();
  const canIncludeDanmaku = context?.sourceKind === "live";

  const active = Boolean(controller.active);
  const busy = controller.busy;

  // 从这个盒子（或其他地方）开始录制后，选项盒收回为
  // 活动状态的一键停止按钮。
  useEffect(() => {
    if (active) setOpen(false);
  }, [active]);

  if (!controller.supported) return null;

  const label = active ? "停止录制并保存" : "开始录制";

  function startRecording() {
    controller.start({
      includeDanmaku: canIncludeDanmaku && includeDanmaku,
      continueOnLeave,
    });
    setOverrides({});
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (busy || active) return;
        if (
          !nextOpen ||
          overrides.includeDanmaku !== undefined ||
          overrides.continueOnLeave !== undefined
        ) {
          setOverrides({});
        }
        setOpen(nextOpen);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant={active ? "secondary" : "ghost"}
                  size="icon-sm"
                  className={cn(active && "text-destructive hover:text-destructive", className)}
                  aria-label={label}
                  aria-pressed={active}
                  disabled={disabled || busy || !context}
                  onClick={() => {
                    if (active) controller.stop();
                  }}
                />
              }
            />
          }
        >
          <span className="relative inline-flex">
            {active ? (
              <Square data-icon="inline-start" aria-hidden />
            ) : (
              <CircleDot data-icon="inline-start" aria-hidden />
            )}
            {active && <ToolActiveDot tone="destructive" />}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={12}
        glass
        className={cn(
          "max-h-[calc(100vh-4rem)] w-[min(20rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] overflow-y-auto p-3",
          glassPanelClass(),
        )}
      >
        <PopoverTitle className={cn("px-0.5", glassTitleClass())}>开始录制</PopoverTitle>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={danmakuSwitchId}>包含弹幕</FieldLabel>
            </FieldContent>
            <Switch
              className="self-center"
              id={danmakuSwitchId}
              checked={canIncludeDanmaku && includeDanmaku}
              disabled={!canIncludeDanmaku || busy}
              onCheckedChange={(checked) =>
                setOverrides((current) => ({ ...current, includeDanmaku: Boolean(checked) }))
              }
              aria-label="包含弹幕"
            />
          </Field>
          {!canIncludeDanmaku && (
            <p className="text-xs text-muted-foreground">
              IPTV 频道没有应用内弹幕，因此不会创建弹幕轨。
            </p>
          )}
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={continueSwitchId}>离开页面后继续录制</FieldLabel>
            </FieldContent>
            <Switch
              className="self-center"
              id={continueSwitchId}
              checked={continueOnLeave}
              disabled={busy}
              onCheckedChange={(checked) =>
                setOverrides((current) => ({ ...current, continueOnLeave: Boolean(checked) }))
              }
              aria-label="离开页面后继续录制"
            />
          </Field>
        </FieldGroup>
        <div className="flex items-center justify-end">
          <Button type="button" size="sm" disabled={busy || !context} onClick={startRecording}>
            <CircleDot data-icon="inline-start" aria-hidden />
            {busy ? "正在开始…" : "开始录制"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
