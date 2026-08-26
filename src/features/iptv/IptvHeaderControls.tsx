import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, ListFilter, Search, X } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIptvController } from "./IptvController";
import type { IptvAvailabilityFilter } from "./availability";
import type { PlaylistSource } from "./playlistSource";

type IptvSourceSwitcherProps = {
  sources: readonly PlaylistSource[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
};

/**
 * 与直播平台共用同一应用栏槽位的来源页签。该条带在所有视口下都是 tablist ——
 * 移动端它会扩展填满头部行，与历史页的视图切换器一致。
 */
export function IptvSourceSwitcher({
  sources,
  value,
  onValueChange,
  className,
}: IptvSourceSwitcherProps) {
  return (
    <div className={cn("min-w-0", className)}>
      <span id="iptv-source-label" className="sr-only">
        频道源
      </span>
      <div
        role="tablist"
        aria-labelledby="iptv-source-label"
        className="flex h-full min-w-0 max-w-full items-stretch gap-1 max-md:w-full max-md:gap-0"
      >
        {sources.map((source) => {
          const active = source.id === value;
          const label = source.id === "custom" ? "自定义源" : source.label;
          return (
            <button
              key={source.id}
              type="button"
              role="tab"
              data-motion-control
              aria-selected={active}
              title={source.label}
              onClick={() => onValueChange(source.id)}
              className={cn(
                "relative flex h-full items-center px-3 text-sm font-medium transition-colors duration-150 focus-ring",
                "md:shrink-0 max-md:min-w-0 max-md:flex-1 max-md:justify-center max-md:px-1",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
              )}
            >
              <span className="truncate">{label}</span>
              {active && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type IptvSearchInputProps = {
  keyword: string;
  onChange: (query: string) => void;
  className?: string;
};

/**
 * 频道搜索带短防抖：关键字保存在地址栏里，
 * 逐键写入会在用户还在输入时反复过滤数千个频道。
 */
export function IptvSearchInput({ keyword, onChange, className }: IptvSearchInputProps) {
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
      <label htmlFor="iptv-channel-search" className="sr-only">
        搜索频道
      </label>
      <InputGroup>
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          id="iptv-channel-search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && draft) {
              event.preventDefault();
              setDraft("");
              onChange("");
            }
          }}
          placeholder="搜索频道或分类"
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

function availabilityFilterLabel(filter: IptvAvailabilityFilter): string {
  if (filter === "available") return "仅看可用";
  if (filter === "unavailable") return "仅看不可用";
  if (filter === "unchecked") return "仅看未检测";
  return "全部状态";
}

type IptvAvailabilitySelectProps = {
  className?: string;
  /** 收起为纯图标的触摸按钮，与移动端工具栏一致。 */
  iconOnly?: boolean;
};

/** 桌面侧栏与移动端工具栏共享的可看性过滤器。 */
export function IptvAvailabilitySelect({
  className,
  iconOnly = false,
}: IptvAvailabilitySelectProps) {
  const { availabilityFilter, setAvailabilityFilter } = useIptvController();
  const label = availabilityFilterLabel(availabilityFilter);

  return (
    <Select
      value={availabilityFilter}
      onValueChange={(value) =>
        setAvailabilityFilter((value as IptvAvailabilityFilter | null) ?? "all")
      }
    >
      <SelectTrigger
        size="sm"
        aria-label={`按可用状态筛选：${label}`}
        title={label}
        className={cn(
          "border border-input bg-background",
          iconOnly ? "size-11! shrink-0 justify-center px-0! [&>svg:last-child]:hidden" : "w-full",
          availabilityFilter !== "all" && "border-primary/45 text-primary",
          className,
        )}
      >
        <Activity data-icon="inline-start" aria-hidden />
        <SelectValue className={cn(iconOnly && "hidden!")}>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent align={iconOnly ? "end" : "start"}>
        <SelectGroup>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="available">可用</SelectItem>
          <SelectItem value="unavailable">不可用</SelectItem>
          <SelectItem value="unchecked">未检测</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

type IptvRailControlsProps = {
  className?: string;
};

/** 搜索与可看性过滤器堆叠在桌面页面侧栏顶部。 */
export function IptvRailControls({ className }: IptvRailControlsProps) {
  const { keyword, navigateHome, hasFilters, clearFilters } = useIptvController();

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <IptvSearchInput keyword={keyword} onChange={(query) => navigateHome({ query }, true)} />
      <IptvAvailabilitySelect />
      {hasFilters && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          className="justify-start"
        >
          <X data-icon="inline-start" aria-hidden />
          清除筛选
        </Button>
      )}
    </div>
  );
}

type IptvContentToolbarProps = {
  className?: string;
};

/**
 * 频道网格上方的移动端工具栏：搜索框加图标按钮组和可看性过滤器排成一行，
 * 与历史页一致。桌面端把这些控件放在页面侧栏中。
 */
export function IptvContentToolbar({ className }: IptvContentToolbarProps) {
  const { keyword, groupOptions, selectedGroup, navigateHome, hasFilters, clearFilters } =
    useIptvController();
  const groupLabel = selectedGroup === "all" ? "全部分类" : selectedGroup;

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <IptvSearchInput
        keyword={keyword}
        onChange={(query) => navigateHome({ query }, true)}
        className="min-w-0 flex-1"
      />

      <Select
        value={selectedGroup}
        onValueChange={(value) => navigateHome({ group: value ?? "all" })}
      >
        <SelectTrigger
          size="sm"
          aria-label={`按分类筛选：${groupLabel}`}
          title={groupLabel}
          className={cn(
            "size-11! shrink-0 justify-center border border-input bg-background px-0! [&>svg:last-child]:hidden",
            selectedGroup !== "all" && "border-primary/45 text-primary",
          )}
        >
          <ListFilter data-icon="inline-start" aria-hidden />
          <SelectValue className="hidden!">{groupLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            <SelectItem value="all">全部分类</SelectItem>
            {groupOptions.map((group) => (
              <SelectItem key={group.value} value={group.value}>
                <span className="min-w-0 flex-1 truncate">{group.value}</span>
                <span className="text-xs text-muted-foreground">{group.count}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <IptvAvailabilitySelect iconOnly />

      {hasFilters && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={clearFilters}
          aria-label="清除筛选"
          title="清除筛选"
          className="size-11 shrink-0"
        >
          <X aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** 手动 IPTV 可看性探测放在内容区角落，保持 Shell 侧栏紧凑。 */
export function IptvAvailabilityFab() {
  const {
    matchingChannels,
    playlistQuery,
    availabilityProgress,
    isCheckingAvailability,
    checkChannelAvailability,
  } = useIptvController();
  const pending = playlistQuery.isFetching || isCheckingAvailability;
  const label = availabilityProgress
    ? `检测频道可用性（${availabilityProgress.completed}/${availabilityProgress.total}）`
    : "检测频道可用性";

  return createPortal(
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="default"
            size="icon-lg"
            aria-label={label}
            disabled={matchingChannels.length === 0 || pending}
            onClick={() => void checkChannelAvailability()}
            className={cn(
              "fixed right-4 bottom-[4.5rem] z-30 size-11 rounded-full p-0 shadow-lg shadow-black/25 md:right-5 md:bottom-[4.25rem]",
              "max-md:bottom-[calc(8.5rem+env(safe-area-inset-bottom))]",
            )}
          />
        }
      >
        {pending ? (
          <Spinner className="size-5" aria-hidden />
        ) : (
          <Activity className="size-5" aria-hidden />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>,
    document.body,
  );
}
