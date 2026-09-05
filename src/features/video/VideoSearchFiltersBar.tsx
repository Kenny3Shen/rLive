import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import {
  CHIP_STRIP_CLASS,
  ChipButton,
  StripArrow,
  handleStripArrowKeys,
  scrollStripByPage,
  useCenterActiveChip,
  useStripEdges,
} from "@/shared/components/ChipStrip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { videoSearchZoneList } from "./videoApi";
import {
  VIDEO_SEARCH_DURATIONS,
  VIDEO_SEARCH_ORDERS,
  VIDEO_SEARCH_PUB_TIMES,
  type VideoSearchFilters,
  type VideoSearchOrder,
} from "./videoRoute";

/**
 * 视频搜索的排序与筛选条，结构参考 B 站 Web 端搜索页：排序是一行可横滚的
 * chip，时长 / 分区 / 发布时间是三个独立下拉，各自显示当前值——不收进单个
 * 「筛选」按钮，也没有单独的重置：每个维度选回首项即恢复默认。
 *
 * 筛选住在 URL（`?order/&duration/&zone/&pubtime=`），组件无自持状态：点选即
 * 回调 `onChange`，页面据此改写 URL，查询键变化自动重新搜索。排序条复用
 * `ChipStrip` 的横滚 / 箭头 / 键盘逻辑（与首页分区条同一套）。
 */
export function VideoSearchFiltersBar({
  filters,
  onChange,
}: {
  filters: VideoSearchFilters;
  onChange: (next: VideoSearchFilters) => void;
}) {
  const zonesQuery = useQuery({
    queryKey: ["video_search_zone_list"],
    queryFn: videoSearchZoneList,
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const durationOptions = VIDEO_SEARCH_DURATIONS.map((option) => ({
    value: String(option.value),
    label: option.label,
  }));
  // 发布时间的默认是空串（默认位不进 URL）；下拉里用 "all" 占位，避免把空串
  // 交给 Select（会被当成占位符语义）。
  const pubTimeOptions = [
    { value: "all", label: VIDEO_SEARCH_PUB_TIMES[0].label },
    ...VIDEO_SEARCH_PUB_TIMES.slice(1).map((option) => ({
      value: option.value,
      label: option.label,
    })),
  ];
  const zoneOptions = [
    { value: "0", label: "全部分区" },
    ...(zonesQuery.data ?? []).map(([label, tid]) => ({ value: String(tid), label })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <OrderStrip
        value={filters.order}
        onSelect={(order) => onChange({ ...filters, order })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <VideoSearchFilterSelect
          label="时长"
          options={durationOptions}
          value={String(filters.duration)}
          onSelect={(next) =>
            onChange({
              ...filters,
              duration: VIDEO_SEARCH_DURATIONS.find(
                (option) => String(option.value) === next,
              )?.value ?? 0,
            })
          }
        />
        <VideoSearchFilterSelect
          label="分区"
          options={zoneOptions}
          value={String(filters.zone)}
          onSelect={(next) => onChange({ ...filters, zone: Number(next) })}
        />
        <VideoSearchFilterSelect
          label="发布时间"
          options={pubTimeOptions}
          value={filters.pubTime || "all"}
          onSelect={(next) =>
            onChange({
              ...filters,
              pubTime:
                VIDEO_SEARCH_PUB_TIMES.find((option) => option.value === next)
                  ?.value ?? "",
            })
          }
        />
      </div>
    </div>
  );
}

/** 排序 chip 条。与分区条同一套横滚、箭头与键盘导航，只是数据是六个排序档。 */
function OrderStrip({
  value,
  onSelect,
}: {
  value: VideoSearchOrder;
  onSelect: (order: VideoSearchOrder) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  // 排序集合是静态的，contentKey 固定即可。
  const edges = useStripEdges(stripRef, "video-search-orders");
  useCenterActiveChip(stripRef, "video-search-orders", value);

  return (
    <div className="flex min-w-0 flex-1 basis-56 items-center gap-2">
      <StripArrow
        side="start"
        mounted={edges.overflowing}
        enabled={edges.start}
        onClick={() => scrollStripByPage(stripRef.current, -1)}
      />
      <div
        ref={stripRef}
        role="tablist"
        aria-label="排序方式"
        aria-orientation="horizontal"
        onKeyDown={(event) => handleStripArrowKeys(stripRef.current, event)}
        data-horizontal-swipe-surface
        className={CHIP_STRIP_CLASS}
      >
        {VIDEO_SEARCH_ORDERS.map((option) => (
          <ChipButton
            key={option.label}
            label={option.label}
            active={option.value === value}
            tabStop={option.value === value}
            onClick={() => {
              if (option.value !== value) onSelect(option.value);
            }}
          />
        ))}
      </div>
      <StripArrow
        side="end"
        mounted={edges.overflowing}
        enabled={edges.end}
        onClick={() => scrollStripByPage(stripRef.current, 1)}
      />
    </div>
  );
}

/**
 * 单个筛选下拉。首项即默认值（「全部时长 / 全部分区 / 全部时间」），选中非首项
 * 时触发器高亮提示；B 站 Web 端同款「当前值 ▾」形态。
 */
function VideoSearchFilterSelect({
  label,
  options,
  value,
  onSelect,
}: {
  /** 维度名，仅用于 aria-label。 */
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onSelect: (value: string) => void;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) onSelect(next);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`按${label}筛选：${current?.label ?? label}`}
        title={`按${label}筛选`}
        className={cn(
          "border border-input bg-background",
          current && current !== options[0] && "border-primary/45 text-primary",
        )}
      >
        <SelectValue>{current?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="min-w-36">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
