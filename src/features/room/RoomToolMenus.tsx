import { useEffect, useState } from "react";
import { Car, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AutoDanmakuSendController } from "./danmaku/useAutoDanmakuSend";
import {
  AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS,
  AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS,
  normalizeAutoDanmakuSendIntervalSeconds,
} from "./danmaku/autoSend";
import {
  formatSleepTimer,
  MAX_SLEEP_TIMER_MINUTES,
  MIN_SLEEP_TIMER_MINUTES,
  normalizeSleepTimerMinutes,
  type SleepTimerController,
} from "./useSleepTimer";
import {
  glassOptionClass,
  glassOptionSelectedClass,
  glassTitleClass,
} from "@/shared/components/player/glassSurface";

export type RoomToolMenuVariant = "default" | "overlay";

type MenuStyle = {
  text: string;
  mutedText: string;
  control: string;
  badge: string;
  divider: string;
};

function menuStyle(variant: RoomToolMenuVariant): MenuStyle {
  if (variant === "overlay") {
    return {
      text: "text-white",
      mutedText: "text-white/65",
      control:
        "border-white/15 bg-black/15 text-white placeholder:text-white/45 [&_[data-slot=input-group-control]]:text-white",
      badge: "border-white/20 text-white/75",
      divider: "border-white/10",
    };
  }
  return {
    text: "text-foreground",
    mutedText: "text-muted-foreground",
    control: "",
    badge: "",
    divider: "border-border/60",
  };
}

function MenuHeader({
  icon: Icon,
  label,
  badge,
  variant,
}: {
  icon: typeof Car;
  label: string;
  badge?: string;
  variant: RoomToolMenuVariant;
}) {
  const style = menuStyle(variant);
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <div
        className={cn(
          "flex min-w-0 items-center gap-2",
          glassTitleClass({ overlay: variant === "overlay" }),
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      {badge && (
        <Badge variant="outline" className={cn("shrink-0", style.badge)}>
          {badge}
        </Badge>
      )}
    </div>
  );
}

export function AutoDanmakuSendMenu({
  autoSend,
  variant = "default",
  idPrefix = "room-auto-danmaku",
  showHeader = true,
}: {
  autoSend: AutoDanmakuSendController;
  variant?: RoomToolMenuVariant;
  idPrefix?: string;
  showHeader?: boolean;
}) {
  const [intervalDraft, setIntervalDraft] = useState(() => String(autoSend.intervalSeconds));
  const style = menuStyle(variant);

  useEffect(() => {
    setIntervalDraft(String(autoSend.intervalSeconds));
  }, [autoSend.intervalSeconds]);

  const commitInterval = () => {
    const intervalSeconds = normalizeAutoDanmakuSendIntervalSeconds(Number(intervalDraft));
    autoSend.onIntervalChange(intervalSeconds);
    setIntervalDraft(String(intervalSeconds));
  };

  const segmentLabel =
    autoSend.currentSegmentIndex === null || autoSend.segmentCount === 0
      ? `${autoSend.segmentCount} 段`
      : `${autoSend.currentSegmentIndex + 1}/${autoSend.segmentCount} 段`;
  const statusIsError = autoSend.phase === "paused";
  const textId = `${idPrefix}-text`;
  const intervalId = `${idPrefix}-interval`;
  const enabledId = `${idPrefix}-enabled`;

  return (
    <div className={cn("min-w-0 space-y-4", style.text)}>
      {showHeader && (
        <MenuHeader icon={Car} label="自动发送弹幕" badge={segmentLabel} variant={variant} />
      )}

      <div className="space-y-2">
        <label htmlFor={textId} className="block text-sm font-medium">
          发送内容
        </label>
        <Textarea
          id={textId}
          value={autoSend.text}
          rows={3}
          placeholder="输入要循环发送的普通弹幕"
          className={cn("min-h-20 resize-y", style.control)}
          onChange={(event) => autoSend.onTextChange(event.target.value)}
        />
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2">
        <label htmlFor={intervalId} className="min-w-0 text-sm font-medium">
          发送间隔
        </label>
        <InputGroup className={cn("w-28 max-w-full", style.control)}>
          <InputGroupInput
            id={intervalId}
            type="number"
            inputMode="numeric"
            min={AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS}
            max={AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS}
            step={1}
            value={intervalDraft}
            onChange={(event) => setIntervalDraft(event.currentTarget.value)}
            onBlur={commitInterval}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <InputGroupAddon align="inline-end" className={style.mutedText}>
            秒
          </InputGroupAddon>
        </InputGroup>
      </div>

      <div
        className={cn(
          "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-t pt-3",
          style.divider,
        )}
      >
        <div className="min-w-0">
          <label htmlFor={enabledId} className="block text-sm font-medium">
            自动发送
          </label>
          <p
            className={cn(
              "mt-1 break-words text-xs leading-5",
              statusIsError ? "text-red-300" : style.mutedText,
            )}
            role="status"
            aria-live="polite"
          >
            {autoSend.statusMessage}
          </p>
        </div>
        <Switch
          id={enabledId}
          checked={autoSend.enabled}
          disabled={!autoSend.canEnable}
          onCheckedChange={autoSend.onEnabledChange}
        />
      </div>
    </div>
  );
}

const SLEEP_TIMER_PRESETS = [15, 30, 60, 120] as const;

export function SleepTimerMenu({
  timer,
  expanded = true,
  onExpandedChange,
  variant = "default",
  showTrigger = true,
  showHeader = true,
}: {
  timer: SleepTimerController;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  variant?: RoomToolMenuVariant;
  showTrigger?: boolean;
  showHeader?: boolean;
}) {
  const [minutesDraft, setMinutesDraft] = useState(String(timer.durationMinutes));
  const [draftError, setDraftError] = useState<string | null>(null);
  const style = menuStyle(variant);

  useEffect(() => {
    setMinutesDraft(String(timer.durationMinutes));
  }, [timer.durationMinutes]);

  const startTimer = () => {
    const minutes = Number(minutesDraft);
    if (!Number.isFinite(minutes) || minutes < MIN_SLEEP_TIMER_MINUTES) {
      setDraftError(`请输入 ${MIN_SLEEP_TIMER_MINUTES}–${MAX_SLEEP_TIMER_MINUTES} 分钟。`);
      return;
    }
    const normalizedMinutes = normalizeSleepTimerMinutes(minutes);
    setMinutesDraft(String(normalizedMinutes));
    setDraftError(null);
    timer.start(normalizedMinutes);
  };

  const triggerClass =
    variant === "overlay"
      ? cn(
          "h-auto min-w-0 flex-col gap-1.5 py-2.5 text-xs font-normal touch-manipulation max-md:py-3",
          glassOptionClass({ overlay: true }),
          (expanded || timer.active) && glassOptionSelectedClass({ overlay: true }),
        )
      : "h-auto min-w-0 flex-col gap-1.5 py-2.5 text-xs font-normal";

  return (
    <div className={cn("min-w-0", style.text)}>
      {showTrigger && (
        <div className="grid grid-cols-4 gap-1.5 max-md:gap-2">
          <Button
            type="button"
            variant="ghost"
            className={cn("col-span-1", triggerClass)}
            aria-expanded={expanded}
            onClick={() => onExpandedChange?.(!expanded)}
          >
            <Timer className="size-5" aria-hidden />
            <span className="max-w-full truncate">{timer.active ? "定时中" : "定时关闭"}</span>
          </Button>
        </div>
      )}

      {(!showTrigger || expanded) && (
        <div
          className={cn(
            showTrigger && "mt-1.5 rounded-lg p-3",
            showTrigger &&
              (variant === "overlay" ? "bg-black/15 ring-1 ring-white/10" : "bg-muted/40"),
          )}
        >
          {!showTrigger && showHeader && (
            <MenuHeader icon={Timer} label="定时关闭" variant={variant} />
          )}
          {timer.active ? (
            <div
              className={cn(
                "flex min-w-0 items-center justify-between gap-3",
                !showTrigger && showHeader && "mt-3",
              )}
              role="status"
              aria-live="polite"
            >
              <div className="min-w-0">
                <div className="font-mono text-xl font-semibold tabular-nums tracking-tight">
                  {formatSleepTimer(timer.remainingSeconds)}
                </div>
                <p className={cn("mt-1 text-xs", style.mutedText)}>结束后自动退出应用</p>
              </div>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className={variant === "overlay" ? glassOptionClass({ overlay: true }) : undefined}
                onClick={timer.cancel}
              >
                取消
              </Button>
            </div>
          ) : (
            <>
              <div
                className={cn("grid grid-cols-4 gap-1.5", !showTrigger && showHeader && "mt-3")}
                role="group"
                aria-label="快速设置定时"
              >
                {SLEEP_TIMER_PRESETS.map((minutes) => (
                  <Button
                    key={minutes}
                    type="button"
                    size="xs"
                    variant="ghost"
                    className={cn(
                      "min-w-0 px-0.5 text-xs font-medium",
                      variant === "overlay" && glassOptionClass({ overlay: true }),
                      variant === "overlay" &&
                        minutesDraft === String(minutes) &&
                        glassOptionSelectedClass({ overlay: true }),
                    )}
                    onClick={() => {
                      setMinutesDraft(String(minutes));
                      setDraftError(null);
                    }}
                  >
                    {minutes} 分钟
                  </Button>
                ))}
              </div>
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <InputGroup className={cn("min-w-0 flex-1", style.control)}>
                  <InputGroupInput
                    aria-label="定时分钟数"
                    type="number"
                    inputMode="numeric"
                    min={MIN_SLEEP_TIMER_MINUTES}
                    max={MAX_SLEEP_TIMER_MINUTES}
                    step={1}
                    value={minutesDraft}
                    aria-invalid={draftError ? true : undefined}
                    onChange={(event) => {
                      setMinutesDraft(event.currentTarget.value);
                      setDraftError(null);
                    }}
                  />
                  <InputGroupAddon align="inline-end" className={style.mutedText}>
                    分钟
                  </InputGroupAddon>
                </InputGroup>
                <Button type="button" size="sm" className="shrink-0" onClick={startTimer}>
                  开始
                </Button>
              </div>
              {draftError && <p className="mt-2 text-xs text-red-300">{draftError}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
