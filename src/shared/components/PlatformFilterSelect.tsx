import { LayoutGrid, ListFilter } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, SITE_LABELS } from "@/lib/utils";
import { SiteLogo } from "./SiteLogo";
import type { SiteId } from "@/shared/types/live";

export type PlatformFilter = "all" | SiteId;

export function PlatformFilterSelect({
  value,
  sites,
  onValueChange,
  compact = true,
  className,
}: {
  value: PlatformFilter;
  sites: readonly SiteId[];
  onValueChange: (value: PlatformFilter) => void;
  compact?: boolean;
  className?: string;
}) {
  const label = value === "all" ? "全部平台" : (SITE_LABELS[value] ?? value);

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const filter = next as PlatformFilter | null;
        if (filter && (filter === "all" || sites.includes(filter))) onValueChange(filter);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`按平台筛选：${label}`}
        title={label}
        className={cn(
          compact
            ? "shrink-0 border border-input bg-background max-md:h-11! max-sm:size-11! max-sm:justify-center max-sm:px-0! max-sm:[&>svg:last-child]:hidden"
            : "w-full border border-input bg-background max-md:h-11!",
          value !== "all" && "border-primary/45 text-primary",
          className,
        )}
      >
        {value === "all" ? (
          <ListFilter data-icon="inline-start" aria-hidden />
        ) : (
          <SiteLogo siteId={value} />
        )}
        <SelectValue className={cn(compact && "max-sm:hidden!")}>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent
        align={compact ? "end" : "start"}
        alignItemWithTrigger={false}
        className="min-w-44"
      >
        <SelectGroup>
          <SelectItem value="all" aria-label="全部平台">
            <LayoutGrid aria-hidden />
            全部平台
          </SelectItem>
          {sites.map((siteId) => (
            <SelectItem key={siteId} value={siteId} aria-label={SITE_LABELS[siteId] ?? siteId}>
              <SiteLogo siteId={siteId} />
              {SITE_LABELS[siteId] ?? siteId}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
