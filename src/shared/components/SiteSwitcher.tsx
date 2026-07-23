import { useEffect, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { SiteInfo } from "@/shared/types/live";
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
      className="flex items-center gap-1 rounded-full bg-card/80 p-1 ring-1 ring-border-subtle backdrop-blur-sm"
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
              "relative flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-all focus-ring",
              active
                ? "bg-muted text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-35",
            )}
          >
            <span
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
              style={{ backgroundColor: accent }}
              aria-hidden
            >
              {label.slice(0, 1)}
            </span>
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
