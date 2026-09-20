import { useId, useState, type RefObject } from "react";
import { CircleDot, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { mediaPopupTriggerOpenClass } from "@/components/videojs/lib/popup-surface";
import { glassPanelClass, glassTitleClass } from "@/shared/components/player/glassSurface";
import {
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
} from "@/shared/components/player/PlayerControls";
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
  /**
   * `default` 是应用顶栏（IPTV 流内页顶栏），跟邻居的 shadcn 图标按钮对齐；
   * `overlay` 是画面之上的全屏 HUD，跟返回箭头、溢出菜单同一套 36px MediaButton。
   */
  variant?: "default" | "overlay";
  /**
   * Popover portal 目标。默认 <body>；原生全屏下 body 弹层会被 top layer 盖住，
   * 此时传入播放器舞台，使录制选项盒渲染进全屏元素内部（与 PlayerControls 同一取舍）。
   */
  portalContainer?: HTMLElement | RefObject<HTMLElement | null> | null;
};

/**
 * 直播房间与 IPTV 共享的唯一标题栏录制入口。开始时打开与房间工具（定时关闭）
 * 相同的玻璃选项盒；停止保持一键保存动作。
 */
export function RecordingControl({
  context,
  className,
  disabled = false,
  variant = "default",
  portalContainer,
}: RecordingControlProps) {
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
  // 活动状态的一键停止按钮。渲染期调整模式：active 变化的当次渲染即收起。
  const [prevRecordingActive, setPrevRecordingActive] = useState(!active);
  if (active !== prevRecordingActive) {
    setPrevRecordingActive(active);
    if (active) setOpen(false);
  }

  if (!controller.supported) return null;

  const label = active ? "停止录制并保存" : "开始录制";
  const overlay = variant === "overlay";
  const triggerDisabled = disabled || busy || !context;

  // 两种宿主的按钮几何与配色完全不同：HUD 在画面之上，必须用与返回箭头、
  // 溢出菜单一致的 36px 白色 MediaButton；应用顶栏则跟随邻居的 shadcn 图标按钮。
  const trigger = overlay ? (
    <MediaButton
      type="button"
      aria-label={label}
      aria-pressed={active}
      // MediaButton 的禁用观感挂在 aria-disabled 上，disabled 只阻断交互。
      aria-disabled={triggerDisabled || undefined}
      disabled={triggerDisabled}
      className={cn(
        PLAYER_HUD_BUTTON_CLASS,
        // 展开期间用中性填充，盖掉 MediaButton 对 `aria-expanded` 画的 accent 蓝
        // （与音量、播放设置、字幕触发器同一条配方）。
        open && mediaPopupTriggerOpenClass,
        active && "text-destructive hover:text-destructive",
        className,
      )}
      onClick={() => {
        if (active) controller.stop();
      }}
    />
  ) : (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon-sm"
      className={cn(active && "text-destructive hover:text-destructive", className)}
      aria-label={label}
      aria-pressed={active}
      disabled={triggerDisabled}
      onClick={() => {
        if (active) controller.stop();
      }}
    />
  );
  const iconClass = overlay ? PLAYER_HUD_ICON_CLASS : undefined;

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
        <TooltipTrigger render={<PopoverTrigger render={trigger} />}>
          <span className="relative inline-flex">
            {active ? (
              <Square className={iconClass} data-icon="inline-start" aria-hidden />
            ) : (
              <CircleDot className={iconClass} data-icon="inline-start" aria-hidden />
            )}
            {active && <ToolActiveDot tone="destructive" />}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        container={portalContainer}
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
