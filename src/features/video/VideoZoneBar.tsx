import { useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CHIP_BAR_CLASS,
  CHIP_HEIGHT,
  CHIP_RADIUS,
  CHIP_SKELETON_WIDTHS,
  CHIP_STRIP_CLASS,
  ChipButton,
  StripArrow,
  handleStripArrowKeys,
  scrollStripByPage,
  useCenterActiveChip,
  useStripEdges,
} from "@/shared/components/ChipStrip";
import { cn } from "@/lib/utils";
import type { VideoZoneChip } from "./videoRoute";

/**
 * 视频页的分区条。
 *
 * 与首页的直播分区条共用 `shared/components/ChipStrip` 的尺寸、横滚箭头、roving
 * tabindex 与居中滚动，差别只在数据来源与 `aria-label`：这里的 chip 是 UGC 分区
 * （`video_zone_list()`）或 PGC 的 season_type 筛选，而不是 `LiveCategory`。
 *
 * 没有「全部分类」入口：UGC 分区一共 15 项、PGC 各 3 项，一条横滚装得下，
 * 不需要再开一棵树。
 */
export function VideoZoneBar({
  chips,
  selectedKey,
  loading,
  onSelect,
}: {
  chips: readonly VideoZoneChip[];
  selectedKey: string | null;
  loading: boolean;
  onSelect: (key: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const contentKey = chips.map((chip) => chip.key).join("|");
  const edges = useStripEdges(stripRef, contentKey);
  useCenterActiveChip(stripRef, contentKey, selectedKey ?? "");

  // roving tabindex：选中项不在条带里（换页签的那一帧）时退到第一项，
  // 于是永远恰好有一个 `tabindex="0"`。
  const tabStopKey =
    selectedKey && chips.some((chip) => chip.key === selectedKey)
      ? selectedKey
      : (chips[0]?.key ?? null);

  return (
    <div className={CHIP_BAR_CLASS}>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <StripArrow
            side="start"
            mounted={edges.overflowing}
            enabled={edges.start}
            onClick={() => scrollStripByPage(stripRef.current, -1)}
          />
          <div
            ref={stripRef}
            role="tablist"
            aria-label="视频分区"
            aria-orientation="horizontal"
            onKeyDown={(event) => handleStripArrowKeys(stripRef.current, event)}
            // 横向留给这条 strip，纵向仍归页面；同时声明成横滑手势的自有表面，
            // 使 Shell 的页签切换手势不会把这里的横向滚动抢走。
            data-horizontal-swipe-surface
            className={CHIP_STRIP_CLASS}
          >
            {loading && chips.length === 0
              ? CHIP_SKELETON_WIDTHS.map((width, index) => (
                  <Skeleton
                    key={index}
                    className={cn(CHIP_HEIGHT, CHIP_RADIUS, "shrink-0", width)}
                  />
                ))
              : chips.map((chip) => (
                  <ChipButton
                    key={chip.key}
                    label={chip.label}
                    active={chip.key === selectedKey}
                    tabStop={tabStopKey === chip.key}
                    onClick={() => onSelect(chip.key)}
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
      </div>
    </div>
  );
}
