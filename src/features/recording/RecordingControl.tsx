import { useEffect, useId, useState } from "react";
import { CircleDot, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { glassPanelClass, glassTitleClass } from "@/shared/components/player/glassSurface";
import { ToolActiveDot } from "@/shared/components/player/ToolActiveDot";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { useRecordingController, type RecordingContext } from "./recording";

type RecordingControlProps = {
  context: RecordingContext | null;
  className?: string;
  disabled?: boolean;
};

/**
 * The single title-bar recording affordance shared by live rooms and IPTV.
 * Starting opens the same glass option box used by the room tools (定时关闭);
 * stopping remains a one-click save action.
 */
export function RecordingControl({ context, className, disabled = false }: RecordingControlProps) {
  const controller = useRecordingController(context);
  const defaultIncludeDanmaku = useSettingsStore((state) => state.recordingIncludeDanmaku);
  const defaultContinueOnLeave = useSettingsStore((state) => state.recordingContinueAfterLeave);
  const [open, setOpen] = useState(false);
  const [includeDanmaku, setIncludeDanmaku] = useState(defaultIncludeDanmaku);
  const [continueOnLeave, setContinueOnLeave] = useState(defaultContinueOnLeave);
  const danmakuSwitchId = useId();
  const continueSwitchId = useId();
  const canIncludeDanmaku = context?.sourceKind === "live";

  const active = Boolean(controller.active);
  const busy = controller.busy;

  // A recording started from this box (or elsewhere) collapses the option box
  // back into the active one-click stop trigger.
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
    setIncludeDanmaku(defaultIncludeDanmaku);
    setContinueOnLeave(defaultContinueOnLeave);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (busy || active) return;
        if (nextOpen) {
          setIncludeDanmaku(defaultIncludeDanmaku);
          setContinueOnLeave(defaultContinueOnLeave);
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="icon-sm"
            className={cn(active && "text-destructive hover:text-destructive", className)}
            aria-label={label}
            title={label}
            aria-pressed={active}
            disabled={disabled || busy || !context}
            onClick={() => {
              if (active) controller.stop();
            }}
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
      </PopoverTrigger>
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
              <FieldDescription>
                另存为可开关的同步弹幕轨，不会永久烧录进视频；后台录制时会持续收集到录制结束。
              </FieldDescription>
            </FieldContent>
            <Switch
              id={danmakuSwitchId}
              checked={canIncludeDanmaku && includeDanmaku}
              disabled={!canIncludeDanmaku || busy}
              onCheckedChange={(checked) => setIncludeDanmaku(Boolean(checked))}
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
              id={continueSwitchId}
              checked={continueOnLeave}
              disabled={busy}
              onCheckedChange={(checked) => setContinueOnLeave(Boolean(checked))}
              aria-label="离开页面后继续录制"
            />
          </Field>
        </FieldGroup>
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={busy || !context} onClick={startRecording}>
            <CircleDot data-icon="inline-start" aria-hidden />
            {busy ? "正在开始…" : "开始录制"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
