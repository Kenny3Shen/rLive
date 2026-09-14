import { useEffect, useId, useState } from "react";
import {
  CalendarDays,
  Clock3,
  MessageSquareText,
  MonitorPlay,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { DateRange } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldDescription, FieldTitle } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  HISTORY_DATE_PRESETS,
  type HistoryDateFilter,
  historyDateFilterFromDays,
  historyDateFilterLabel,
  historyDayRange,
} from "./historyFilter";
import { HISTORY_VIEWS, type HistoryView } from "./historyRoute";

export { PlatformFilterSelect as HistoryPlatformFilterControl } from "@/shared/components/PlatformFilterSelect";

const VIEW_LABELS: Record<HistoryView, string> = {
  watch: "观看历史",
  video: "视频历史",
  danmaku: "弹幕历史",
};

const VIEW_ICONS = {
  watch: Clock3,
  video: MonitorPlay,
  danmaku: MessageSquareText,
} as const;

const CLEAR_LABELS: Record<HistoryView, string> = {
  watch: "清空观看历史",
  video: "清空视频历史",
  danmaku: "清空弹幕历史",
};

/**
 * 时间线切换器，在 `/history` 上取代应用头部的平台条。它与平台条一样是
 * `tablist`：三个面板并排位于同一条可滑动的 track 上。
 */
export function HistoryViewSwitcher({
  value,
  onValueChange,
  className,
}: {
  value: HistoryView;
  onValueChange: (view: HistoryView) => void;
  className?: string;
}) {
  return (
    <div
      className={cn("flex h-full items-stretch gap-1 max-md:w-full", className)}
      role="tablist"
      aria-label="历史记录类型"
    >
      {HISTORY_VIEWS.map((view) => {
        const active = view === value;
        const Icon = VIEW_ICONS[view];
        return (
          <button
            key={view}
            type="button"
            role="tab"
            data-motion-control
            aria-selected={active}
            title={VIEW_LABELS[view]}
            onClick={() => onValueChange(view)}
            className={cn(
              "relative flex h-full items-center gap-2 px-4 text-sm font-medium transition-colors duration-150 focus-ring max-md:min-w-0 max-md:flex-1 max-md:justify-center",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span>{VIEW_LABELS[view]}</span>
            {active && (
              <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 对活动时间线的自由文本搜索。
 *
 * 输入框维护自己的草稿状态并以短防抖向上推送：真正的取值在地址栏里，
 * 每次击键都写 search 参数既会刷屏路由更新，
 * 也会在用户还在输入时反复执行分组计算。
 */
export function HistorySearchInput({
  keyword,
  onChange,
  className,
}: {
  keyword: string;
  onChange: (keyword: string) => void;
  className?: string;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(keyword);

  // 采纳外部变更（清除过滤、恢复 URL），同时不覆盖用户正在输入的内容：
  // 渲染期调整模式，直接与当前草稿比较。
  const [prevKeyword, setPrevKeyword] = useState(keyword);
  if (keyword !== prevKeyword) {
    setPrevKeyword(keyword);
    if (keyword !== draft) setDraft(keyword);
  }

  useEffect(() => {
    if (draft === keyword) return;
    const timer = window.setTimeout(() => onChange(draft), 220);
    return () => window.clearTimeout(timer);
  }, [draft, keyword, onChange]);

  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={inputId} className="sr-only">
        搜索历史记录
      </label>
      <InputGroup>
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && draft) {
              event.preventDefault();
              setDraft("");
              onChange("");
            }
          }}
          placeholder="搜索标题、UP 主或弹幕"
          autoComplete="off"
        />
        {draft && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="清除搜索"
              onClick={() => {
                setDraft("");
                onChange("");
              }}
            >
              <X aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </div>
  );
}

/**
 * 日期过滤：相对预设加自定义日期范围。范围用 shadcn `Calendar` 的 `range` 模式，
 * 它在桌面和触屏上呈现同一套中文月历；首点定起点、再点定终点，同一天点两次
 * 表示单日。历史不会落在未来，因此今天之后不可选。
 */
export function HistoryDateFilterControl({
  value,
  onValueChange,
  className,
}: {
  value: HistoryDateFilter;
  onValueChange: (filter: HistoryDateFilter) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = value !== "all";
  const label = historyDateFilterLabel(value);
  const committedRange = historyDayRange(value);
  // 选到一半的范围（只有起点）不是合法过滤值，先留在本地草稿里：
  // 提前推上去会让时间线在用户还没选完终点时就跳成单日。
  const [draft, setDraft] = useState<DateRange | undefined>(committedRange ?? undefined);
  // 采纳外部变更（预设、清除筛选、恢复 URL），并在关闭时丢弃未选完的草稿，
  // 下次打开不会残留半截高亮。
  const [prevValue, setPrevValue] = useState(value);
  const [prevOpen, setPrevOpen] = useState(open);
  if (value !== prevValue || open !== prevOpen) {
    setPrevValue(value);
    setPrevOpen(open);
    setDraft(committedRange ?? undefined);
  }
  // 每次渲染取当天：挂机过夜后再打开，未来日期仍然按新的今天封锁。
  const today = new Date();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`按日期筛选：${label}`}
                  className={cn(
                    "shrink-0 gap-1.5 max-md:h-11 max-sm:size-11 max-sm:gap-0 max-sm:px-0!",
                    active && "border-primary/45 text-primary",
                    className,
                  )}
                />
              }
            >
              <CalendarDays data-icon="inline-start" aria-hidden />
              <span className="max-sm:hidden">{label}</span>
            </PopoverTrigger>
          }
        />
        <TooltipContent side="bottom">按日期筛选</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-auto p-2">
        <ToggleGroup
          value={committedRange ? [] : [value]}
          onValueChange={(next) => {
            const preset = next[0];
            if (
              !preset ||
              !HISTORY_DATE_PRESETS.includes(preset as (typeof HISTORY_DATE_PRESETS)[number])
            ) {
              return;
            }
            onValueChange(preset as (typeof HISTORY_DATE_PRESETS)[number]);
            setOpen(false);
          }}
          orientation="vertical"
          size="sm"
          className="w-full items-stretch gap-1"
        >
          {HISTORY_DATE_PRESETS.map((preset) => (
            <ToggleGroupItem key={preset} className="justify-start" value={preset}>
              {historyDateFilterLabel(preset)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Separator />
        <Field className="gap-1.5">
          <FieldTitle className="text-xs font-normal text-muted-foreground">日期范围</FieldTitle>
          <FieldDescription className="text-xs">点两次选一段，同一天两次表示单日</FieldDescription>
          <Calendar
            mode="range"
            // 范围选满后再点，从被点的那天重新开始，而不是把已选范围拉长。
            resetOnSelect
            locale={zhCN}
            selected={draft}
            defaultMonth={draft?.from ?? today}
            endMonth={today}
            disabled={{ after: today }}
            onSelect={(range) => {
              setDraft(range);
              if (!range?.from) {
                onValueChange("all");
                return;
              }
              // 只有起点时留着弹层，等用户点第二下定终点。
              if (!range.to) return;
              onValueChange(historyDateFilterFromDays(range.from, range.to));
              setOpen(false);
            }}
            className="p-0"
          />
        </Field>
      </PopoverContent>
    </Popover>
  );
}

/** 针对当前屏幕上时间线的破坏性清空。 */
export function HistoryClearButton({
  view,
  canClear,
  pending,
  onRequestClear,
  className,
}: {
  view: HistoryView;
  canClear: boolean;
  pending: boolean;
  onRequestClear: () => void;
  className?: string;
}) {
  const label = CLEAR_LABELS[view];

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={!canClear || pending}
            aria-label={label}
            aria-haspopup="dialog"
            className={cn("shrink-0 max-md:size-9", className)}
            onClick={onRequestClear}
          />
        }
      >
        {pending ? <Spinner aria-hidden /> : <Trash2 aria-hidden />}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
