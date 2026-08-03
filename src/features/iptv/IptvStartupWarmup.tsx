import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { invokeCmd } from "@/shared/api/tauri";
import { DEFAULT_PLAYLIST_SOURCE, playlistSourceFromRoute } from "./playlistSource";
import { probeIptvAvailability } from "./availabilityProbe";
import type { IptvChannel } from "./types";

const STARTUP_WARMUP_DELAY_MS = 700;

/** Refresh and probe one IPTV source after the first screen has had time to paint. */
export function IptvStartupWarmup() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const customM3uUrl = useSettingsStore((state) => state.iptvCustomM3uUrl);
  const hydratedFromBackend = useSettingsStore((state) => state.hydratedFromBackend);
  const startedRef = useRef(false);

  const source = useMemo(() => {
    if (location.pathname.startsWith("/iptv")) {
      const params = new URLSearchParams(location.search);
      return playlistSourceFromRoute(params.get("source"), params.get("m3u") ?? customM3uUrl);
    }
    const configured = playlistSourceFromRoute("custom", customM3uUrl);
    return configured.id === "custom" ? configured : DEFAULT_PLAYLIST_SOURCE;
  }, [customM3uUrl, location.pathname, location.search]);

  useEffect(() => {
    if (!hydratedFromBackend || startedRef.current) return;
    let cancelled = false;
    const timerId = window.setTimeout(() => {
      if (cancelled || startedRef.current) return;
      startedRef.current = true;
      void queryClient
        .fetchQuery<IptvChannel[]>({
          queryKey: ["iptv_playlist", source.url],
          queryFn: () => invokeCmd<IptvChannel[]>("iptv_load_playlist", { sourceUrl: source.url }),
          staleTime: 0,
        })
        .then((channels) => {
          return probeIptvAvailability(channels, { sourceUrl: source.url, notify: false });
        })
        .catch(() => {
          // Startup maintenance is deliberately silent; IPTV remains available
          // for a manual retry from its page when a source is temporarily down.
        });
    }, STARTUP_WARMUP_DELAY_MS);
    return () => {
      if (!startedRef.current) {
        cancelled = true;
        window.clearTimeout(timerId);
      }
    };
  }, [hydratedFromBackend, queryClient, source]);

  return null;
}
