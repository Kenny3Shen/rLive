import { useEffect, useMemo, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { SiteId, SiteInfo } from "@/shared/types/live";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { cn, SITE_ACCENT, SITE_LABELS } from "@/lib/utils";

const FALLBACK_SITES: SiteInfo[] = [
  // These are the shipped platforms. Keeping the fallback usable avoids a
  // visibly disabled first frame while the lightweight `site_list` IPC call
  // resolves, which is especially noticeable when switching platforms.
  { id: "bilibili", name: "Bilibili", ready: true },
  { id: "douyu", name: "Douyu", ready: true },
  { id: "huya", name: "Huya", ready: true },
  { id: "douyin", name: "Douyin", ready: true },
  { id: "kuaishou", name: "Kuaishou", ready: true },
  { id: "twitch", name: "Twitch", ready: true },
];

const PLATFORM_ORDER: readonly SiteId[] = [
  "bilibili",
  "douyu",
  "huya",
  "douyin",
  "kuaishou",
  "twitch",
];

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
  /** Controlled selection for filter use; omitted on the home-page switcher. */
  value?: SiteSwitcherValue;
  onValueChange?: (value: SiteSwitcherValue) => void;
  /** Adds an all-platform option before the regular platform tabs. */
  includeAll?: boolean;
  /** Renders a controlled platform filter rather than the homepage selector. */
  filterMode?: boolean;
  className?: string;
};

export function SiteSwitcher({
  value,
  onValueChange,
  includeAll = false,
  filterMode = false,
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

  const entries: Array<SiteInfo | { id: "all"; name: string; ready: true }> = includeAll
    ? [{ id: "all", name: "全部平台", ready: true }, ...visibleSites]
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
        /* keep fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className={cn("flex h-full items-stretch gap-1", className)}
      role="tablist"
      aria-label={filterMode ? "筛选直播平台" : "直播平台"}
    >
      {entries.map((site) => {
        const active = site.id === selectedValue;
        const disabled = !site.ready && !filterMode;
        const accent = site.id === "all" ? undefined : (SITE_ACCENT[site.id] ?? "#6c8cff");
        const label = site.id === "all" ? site.name : (SITE_LABELS[site.id] ?? site.name);

        return (
          <button
            key={site.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-disabled={disabled}
            disabled={disabled}
            title={site.ready ? label : `${label}（即将支持）`}
            onClick={() => {
              if (disabled) return;
              if (value === undefined && site.id !== "all") setSiteId(site.id);
              onValueChange?.(site.id);
            }}
            className={cn(
              "relative flex h-full items-center gap-2 px-4 text-sm font-medium transition-[color,background-color,transform] duration-200 focus-ring motion-safe:active:scale-[0.98]",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
              disabled && "cursor-not-allowed opacity-35",
            )}
          >
            {site.id === "all" ? (
              <LayoutGrid
                className={cn("size-5 shrink-0", active && "motion-safe:animate-platform-logo")}
              />
            ) : (
              <SiteLogo
                siteId={site.id}
                className={cn(active && "motion-safe:animate-platform-logo")}
              />
            )}
            <span className="hidden sm:inline">{label}</span>
            {active && (
              <span
                key={`${site.id}-indicator`}
                className="absolute inset-x-3 -bottom-px h-0.5 rounded-full motion-safe:animate-platform-indicator"
                style={accent ? { backgroundColor: accent } : undefined}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
