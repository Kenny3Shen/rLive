import { createPortal } from "react-dom";
import { Activity, ListFilter, Radio, Search, X } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
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

/** Source tabs for the same application-bar slot used by live platforms. */
export function IptvSourceSwitcher({
  sources,
  value,
  onValueChange,
  className,
}: IptvSourceSwitcherProps) {
  const selected = sources.find((source) => source.id === value) ?? sources[0];

  return (
    <div className={cn("min-w-0", className)}>
      <span id="iptv-source-label" className="sr-only">
        频道源
      </span>
      <div className="min-w-0 lg:hidden">
        <Select value={value} onValueChange={(next) => next && onValueChange(next)}>
          <SelectTrigger
            className="w-full border border-input bg-background"
            aria-labelledby="iptv-source-label"
          >
            <Radio className="size-4 text-primary" aria-hidden />
            <SelectValue>{selected?.label ?? "选择频道源"}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>
              {sources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {source.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div
        role="tablist"
        aria-labelledby="iptv-source-label"
        className="hidden h-full min-w-0 max-w-full items-stretch gap-1 lg:flex"
      >
        {sources.map((source) => {
          const active = source.id === value;
          const label = source.id === "custom" ? "自定义源" : source.label;
          return (
            <button
              key={source.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={source.label}
              onClick={() => onValueChange(source.id)}
              className={cn(
                "relative flex h-full shrink-0 items-center px-3 text-sm font-medium transition-colors duration-200 focus-ring",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
              )}
            >
              {label}
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
  resultCount?: number | null;
  onChange: (query: string) => void;
  className?: string;
};

export function IptvSearchInput({
  keyword,
  resultCount = null,
  onChange,
  className,
}: IptvSearchInputProps) {
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
          value={keyword}
          onChange={(event) => onChange(event.target.value)}
          placeholder="搜索频道或分类"
          autoComplete="off"
        />
        {resultCount !== null && (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{resultCount} 个</InputGroupText>
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

/** Filters for the IPTV content, owned by Shell's left rail. */
export function IptvHeaderStatusControls({ className }: { className?: string }) {
  const {
    groupOptions,
    selectedGroup,
    navigateHome,
    availabilityFilter,
    setAvailabilityFilter,
    hasFilters,
    clearFilters,
  } = useIptvController();

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <Select
        value={selectedGroup}
        onValueChange={(value) => navigateHome({ group: value ?? "all" })}
      >
        <SelectTrigger
          size="sm"
          className="w-32 max-xl:w-28 max-lg:w-8 max-lg:justify-center max-lg:px-0 [&>[data-slot=select-value]]:max-lg:hidden max-lg:[&>svg:last-child]:hidden"
          aria-label="频道分类"
          title={selectedGroup === "all" ? "全部分类" : selectedGroup}
        >
          <ListFilter data-icon="inline-start" aria-hidden />
          <SelectValue>{selectedGroup === "all" ? "全部分类" : selectedGroup}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
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

      <Select
        value={availabilityFilter}
        onValueChange={(value) =>
          setAvailabilityFilter((value as IptvAvailabilityFilter | null) ?? "all")
        }
      >
        <SelectTrigger
          size="sm"
          className="w-32 max-xl:w-28 max-lg:w-8 max-lg:justify-center max-lg:px-0 [&>[data-slot=select-value]]:max-lg:hidden max-lg:[&>svg:last-child]:hidden"
          aria-label="可用状态"
          title={availabilityFilterLabel(availabilityFilter)}
        >
          <Activity data-icon="inline-start" aria-hidden />
          <SelectValue>{availabilityFilterLabel(availabilityFilter)}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          <SelectGroup>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="available">可用</SelectItem>
            <SelectItem value="unavailable">不可用</SelectItem>
            <SelectItem value="unchecked">未检测</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>

      {hasFilters && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={clearFilters}
          aria-label="清除筛选"
          title="清除筛选"
        >
          <X aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** Manual IPTV availability probe, kept in the content corner so the Shell rail stays compact. */
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
              "fixed right-4 bottom-[4.5rem] z-30 size-11 rounded-full p-0 shadow-lg shadow-black/25 md:right-5 md:bottom-[4.75rem]",
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
