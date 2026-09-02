import { useEffect, useMemo, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { SiteId, SiteInfo } from "@/shared/types/live";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { cn, SITE_ACCENT, SITE_LABELS } from "@/lib/utils";

const FALLBACK_SITES: SiteInfo[] = [
  // 这些是随应用分发的平台。保持兜底可用可避免轻量 `site_list` IPC 解析期间出现
  // 明显禁用的首帧，切换平台时尤其明显。
  { id: "bilibili", name: "Bilibili" },
  { id: "douyu", name: "Douyu" },
  { id: "huya", name: "Huya" },
  { id: "douyin", name: "Douyin" },
  { id: "twitch", name: "Twitch" },
];

const PLATFORM_ORDER: readonly SiteId[] = ["bilibili", "douyu", "huya", "douyin", "twitch"];

const platformOrderIndex = new Map<SiteId, number>(
  PLATFORM_ORDER.map((siteId, index) => [siteId, index]),
);

function sortSites(sites: SiteInfo[]): SiteInfo[] {
  return [...sites].sort(
    (left, right) =>
      (platformOrderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (platformOrderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

type SiteSwitcherValue = SiteId | "all";

type SiteSwitcherProps = {
  /** 过滤器使用的受控选择；首页切换器省略。 */
  value?: SiteSwitcherValue;
  onValueChange?: (value: SiteSwitcherValue) => void;
  /** 在常规平台页签之前加入全部平台选项。 */
  includeAll?: boolean;
  /** 渲染受控的平台过滤器而不是首页选择器。 */
  filterMode?: boolean;
  /** 在指针或键盘激活之前预加载目的地。 */
  onValueIntent?: (value: SiteSwitcherValue) => void;
  className?: string;
};

export function SiteSwitcher({
  value,
  onValueChange,
  includeAll = false,
  filterMode = false,
  onValueIntent,
  className,
}: SiteSwitcherProps) {
  const siteId = useSettingsStore((s) => s.siteId);
  const disabledSiteIds = useSettingsStore((s) => s.disabledSiteIds);
  const setSiteId = useSettingsStore((s) => s.setSiteId);
  const [sites, setSites] = useState<SiteInfo[]>(FALLBACK_SITES);
  const selectedValue = value ?? siteId;
  const visibleSites = useMemo(
    () => sites.filter((site) => isSiteEnabled(site.id, disabledSiteIds)),
    [disabledSiteIds, sites],
  );

  const entries: Array<SiteInfo | { id: "all"; name: string }> = includeAll
    ? [{ id: "all", name: "全部平台" }, ...visibleSites]
    : visibleSites;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await invokeCmd<SiteInfo[]>("site_list");
        if (!cancelled && Array.isArray(list) && list.length > 0) {
          setSites(sortSites(list));
        }
      } catch {
        /* 保留兜底 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className={cn("flex h-full items-stretch gap-1 max-md:w-full", className)}
      role="tablist"
      aria-label={filterMode ? "筛选直播平台" : "直播平台"}
    >
      {entries.map((site) => {
        const active = site.id === selectedValue;
        const accent = site.id === "all" ? undefined : (SITE_ACCENT[site.id] ?? "#6c8cff");
        const label = site.id === "all" ? site.name : (SITE_LABELS[site.id] ?? site.name);

        return (
          <button
            key={site.id}
            type="button"
            role="tab"
            data-motion-control
            aria-selected={active}
            title={label}
            onPointerEnter={() => onValueIntent?.(site.id)}
            onPointerDown={() => onValueIntent?.(site.id)}
            onFocus={() => onValueIntent?.(site.id)}
            onClick={() => {
              if (value === undefined && site.id !== "all") setSiteId(site.id);
              onValueChange?.(site.id);
            }}
            className={cn(
              "relative flex h-full items-center gap-2 px-4 text-sm font-medium transition-colors duration-150 focus-ring max-md:min-w-0 max-md:flex-1 max-md:justify-center max-md:px-2",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
            )}
          >
            {site.id === "all" ? (
              <LayoutGrid className="size-5 shrink-0" />
            ) : (
              <SiteLogo siteId={site.id} />
            )}
            <span className="hidden sm:inline">{label}</span>
            {active && (
              <span
                key={`${site.id}-indicator`}
                className="absolute inset-x-3 -bottom-px h-0.5 rounded-full"
                style={accent ? { backgroundColor: accent } : undefined}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
