import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { VIDEO_TAB_PARAM, VIDEO_ZONE_PARAM, videoTabFromSearch, type VideoTab } from "./videoRoute";

type VideoTabScopeValue = { tab: VideoTab; zone: string | null };
const VideoTabScopeContext = createContext<VideoTabScopeValue | null>(null);

/** 离场面板保留自己的页签与分区，不跟随新 URL 先换成另一份列表。 */
export function VideoTabScope({ value, children }: { value: VideoTab; children: ReactNode }) {
  const [searchParams] = useSearchParams();
  const active = videoTabFromSearch(searchParams.get(VIDEO_TAB_PARAM)) === value;
  const routeZone = searchParams.get(VIDEO_ZONE_PARAM);
  const [retainedZone, setRetainedZone] = useState(active ? routeZone : null);
  const zone = active ? routeZone : retainedZone;
  if (active && retainedZone !== routeZone) setRetainedZone(routeZone);
  const scope = useMemo(() => ({ tab: value, zone }), [value, zone]);
  return createElement(VideoTabScopeContext.Provider, { value: scope }, children);
}

export function useVideoTabScope(): VideoTabScopeValue | null {
  return useContext(VideoTabScopeContext);
}
