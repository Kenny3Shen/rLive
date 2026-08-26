import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, Clock3, MessageSquareText, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  HISTORY_DATE_PRESETS,
  type HistoryDateFilter,
  historyDateFilterLabel,
  isSpecificDayFilter,
} from "./historyFilter";
import { HISTORY_VIEWS, type HistoryView } from "./historyRoute";

export { PlatformFilterSelect as HistoryPlatformFilterControl } from "@/shared/components/PlatformFilterSelect";

const VIEW_LABELS: Record<HistoryView, string> = {
  watch: "观看历史",
  danmaku: "弹幕历史",
};

const VIEW_ICONS = {
  watch: Clock3,
  danmaku: MessageSquareText,
} as const;

/**
 * 时间线切换器，在 `/history` 上取代应用头部的平台条。它与平台条一样是
 * `tablist`：两个面板并排位于同一条可滑动的 track 上。
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
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // 采纳外部变更（清除过滤、恢复 URL），同时不覆盖用户正在输入的内容。
  useEffect(() => {
    if (keyword !== draftRef.current) setDraft(keyword);
  }, [keyword]);

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
          placeholder="搜索标题或弹幕"
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
 * 日期过滤：相对预设加单个精确日期。使用原生 date 输入是刻意的 ——
 * 它是各平台都已为其渲染熟悉选择器的控件，
 * 且其产出的本地 `YYYY-MM-DD` 正是过滤器已经使用的格式。
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
  const dayInputId = useId();
  const active = value !== "all";
  const label = historyDateFilterLabel(value);

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
      <PopoverContent align="end" className="w-60 p-2">
        <ToggleGroup
          value={isSpecificDayFilter(value) ? [] : [value]}
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
          <FieldLabel htmlFor={dayInputId} className="text-xs text-muted-foreground">
            指定日期
          </FieldLabel>
          <Input
            id={dayInputId}
            type="date"
            value={isSpecificDayFilter(value) ? value : ""}
            onChange={(event) => {
              const next = event.target.value;
              onValueChange(next && isSpecificDayFilter(next) ? next : "all");
              if (next) setOpen(false);
            }}
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
  const label = view === "watch" ? "清空观看历史" : "清空弹幕历史";

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
