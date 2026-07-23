import { useEffect, useState } from "react";
import clsx from "clsx";
import { invokeCmd } from "../api/tauri";
import { useSettingsStore } from "../stores/settingsStore";
import type { SiteInfo } from "../types/live";

const FALLBACK_SITES: SiteInfo[] = [
  { id: "bilibili", name: "Bilibili", ready: false },
  { id: "huya", name: "Huya", ready: false },
  { id: "douyu", name: "Douyu", ready: false },
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
        // Outside Tauri or command missing: keep fallback list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Live site">
      {sites.map((site) => {
        const active = site.id === siteId;
        return (
          <button
            key={site.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={site.ready ? site.name : `${site.name} (coming soon)`}
            onClick={() => setSiteId(site.id)}
            className={clsx(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700",
              !site.ready && "opacity-70",
            )}
          >
            {site.name}
            {!site.ready && (
              <span className="ml-1 text-[10px] font-normal opacity-70">WIP</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
