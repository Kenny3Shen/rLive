import { useEffect, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { SiteInfo } from "@/shared/types/live";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { cn, SITE_ACCENT, SITE_LABELS } from "@/lib/utils";

const FALLBACK_SITES: SiteInfo[] = [
  { id: "bilibili", name: "Bilibili", ready: false },
  { id: "douyu", name: "Douyu", ready: false },
  { id: "huya", name: "Huya", ready: false },
  { id: "douyin", name: "Douyin", ready: false },
  { id: "kuaishou", name: "Kuaishou", ready: false },
];

export function SiteSwitcher() {
  const siteId = useSettingsStore((s) => s.siteId);
  const setSiteId = useSettingsStore((s) => s.setSiteId);
  const [sites, setSites] = useState<SiteInfo[]>(FALLBACK_SITES);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await invokeCmd<SiteInfo[]>("site_list");
        if (!cancelled && Array.isArray(list) && list.length > 0) {
          setSites(list);
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
      className="flex h-full items-stretch gap-1"
      role="tablist"
      aria-label="直播平台"
    >
      {sites.map((site) => {
        const active = site.id === siteId;
        const disabled = !site.ready;
        const accent = SITE_ACCENT[site.id] ?? "#6c8cff";
        const label = SITE_LABELS[site.id] ?? site.name;

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
              if (site.ready) setSiteId(site.id);
            }}
            className={cn(
              "relative flex h-full items-center gap-2 px-4 text-sm font-medium transition-colors focus-ring",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
              disabled && "cursor-not-allowed opacity-35",
            )}
          >
            <SiteLogo siteId={site.id} />
            <span className="hidden sm:inline">{label}</span>
            {active && (
              <span
                className="absolute inset-x-3 -bottom-px h-0.5 rounded-full"
                style={{ backgroundColor: accent }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
