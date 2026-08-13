import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { notify } from "@/components/ui/toast";
import { invokeCmd } from "@/shared/api/tauri";
import {
  filterIptvChannelsByAvailability,
  summarizeIptvAvailability,
  type IptvAvailabilityFilter,
  type IptvAvailabilityState,
  type IptvChannelAvailability,
  type IptvAvailabilitySummary,
} from "./availability";
import { useIptvAvailabilityStore } from "./availabilityStore";
import { cancelIptvAvailabilityProbe, probeIptvAvailability } from "./availabilityProbe";
import { filterIptvChannels, getIptvGroupOptions, type IptvGroupOption } from "./filterChannels";
import { iptvHomePath, iptvPlayerPath } from "./iptvRoute";
import type { PlaylistSource } from "./playlistSource";
import type { IptvChannel } from "./types";

const EMPTY_CHANNELS: IptvChannel[] = [];

export type IptvController = {
  source: PlaylistSource;
  channels: IptvChannel[];
  selectedGroup: string;
  keyword: string;
  groupOptions: IptvGroupOption[];
  matchingChannels: IptvChannel[];
  filteredChannels: IptvChannel[];
  availabilityFilter: IptvAvailabilityFilter;
  setAvailabilityFilter: (filter: IptvAvailabilityFilter) => void;
  availabilityByUrl: ReadonlyMap<string, IptvAvailabilityState>;
  availabilityProgress: { completed: number; total: number } | null;
  availabilitySummary: IptvAvailabilitySummary;
  uncheckedCount: number;
  hasFilters: boolean;
  isCheckingAvailability: boolean;
  playlistQuery: UseQueryResult<IptvChannel[], Error>;
  navigateHome: (
    next?: Partial<{ source: PlaylistSource; group: string; query: string }>,
    replace?: boolean,
  ) => void;
  clearFilters: () => void;
  openChannel: (channel: IptvChannel) => void;
  updateSource: () => Promise<void>;
  checkChannelAvailability: () => Promise<IptvChannelAvailability[] | null>;
};

const IptvControllerContext = createContext<IptvController | null>(null);

function messageFromError(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String(error.message);
  }
  if (error instanceof Error) return error.message;
  return String(error ?? "未知错误");
}

export function IptvControllerProvider({
  source,
  active,
  children,
}: PropsWithChildren<{ source: PlaylistSource; active: boolean }>) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const selectedGroup = searchParams.get("group") ?? "all";
  const keyword = searchParams.get("q") ?? "";
  const [availabilityFilter, setAvailabilityFilter] = useState<IptvAvailabilityFilter>("all");
  const availabilityByUrl = useIptvAvailabilityStore((state) => state.byUrl);
  const availabilityProgress = useIptvAvailabilityStore((state) => state.progress);
  const activeSourceRef = useRef<string | null>(null);

  const playlistQuery = useQuery({
    queryKey: ["iptv_playlist", source.url],
    queryFn: () => invokeCmd<IptvChannel[]>("iptv_load_playlist", { sourceUrl: source.url }),
    enabled: active,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
  });
  const channels = active ? (playlistQuery.data ?? EMPTY_CHANNELS) : EMPTY_CHANNELS;
  const groupOptions = useMemo(() => getIptvGroupOptions(channels), [channels]);
  const matchingChannels = useMemo(
    () => filterIptvChannels(channels, { group: selectedGroup, query: keyword }),
    [channels, keyword, selectedGroup],
  );
  const availabilitySummary = useMemo(
    () => summarizeIptvAvailability(matchingChannels, availabilityByUrl),
    [availabilityByUrl, matchingChannels],
  );
  const filteredChannels = useMemo(
    () => filterIptvChannelsByAvailability(matchingChannels, availabilityByUrl, availabilityFilter),
    [availabilityByUrl, availabilityFilter, matchingChannels],
  );
  const hasFilters =
    selectedGroup !== "all" || keyword.trim().length > 0 || availabilityFilter !== "all";
  const isCheckingAvailability = availabilityProgress !== null;
  const uncheckedCount = availabilitySummary.unchecked + availabilitySummary.checking;

  useEffect(() => {
    if (
      !active ||
      channels.length === 0 ||
      selectedGroup === "all" ||
      groupOptions.some((group) => group.value === selectedGroup)
    ) {
      return;
    }
    navigate(iptvHomePath({ source, group: "all", query: keyword }), { replace: true });
  }, [active, channels.length, groupOptions, keyword, navigate, selectedGroup, source]);

  useEffect(() => {
    if (!active) return;
    const cachedSource = useIptvAvailabilityStore.getState().sourceUrl;
    const sourceChanged =
      activeSourceRef.current !== null
        ? activeSourceRef.current !== source.url
        : cachedSource !== null && cachedSource !== source.url;
    if (sourceChanged) {
      cancelIptvAvailabilityProbe();
      useIptvAvailabilityStore.getState().resetForSource(source.url);
      setAvailabilityFilter("all");
    }
    activeSourceRef.current = source.url;
  }, [active, source.url]);

  const navigateHome = useCallback(
    (
      next: Partial<{ source: PlaylistSource; group: string; query: string }> = {},
      replace = false,
    ) => {
      navigate(
        iptvHomePath({
          source: next.source ?? source,
          group: next.group ?? selectedGroup,
          query: next.query ?? keyword,
        }),
        { replace },
      );
    },
    [keyword, navigate, selectedGroup, source],
  );

  const clearFilters = useCallback(() => {
    setAvailabilityFilter("all");
    navigateHome({ group: "all", query: "" }, true);
  }, [navigateHome]);

  const openChannel = useCallback(
    (channel: IptvChannel) => {
      const returnTo = `${location.pathname}${location.search}`;
      navigate(
        iptvPlayerPath({
          source,
          channelUrl: channel.url,
          group: selectedGroup,
          query: keyword,
        }),
        { state: { returnTo } },
      );
    },
    [keyword, location.pathname, location.search, navigate, selectedGroup, source],
  );

  const updateSource = useCallback(async () => {
    cancelIptvAvailabilityProbe();
    const availabilityStore = useIptvAvailabilityStore.getState();
    availabilityStore.clearForSource(source.url);
    setAvailabilityFilter("all");
    try {
      const result = await playlistQuery.refetch();
      if (result.isError) {
        notify.error("频道源更新失败", messageFromError(result.error));
        return;
      }
      notify.success("频道源已更新", `${source.label} · ${result.data?.length ?? 0} 个频道`);
    } catch (error) {
      notify.error("频道源更新失败", messageFromError(error));
    }
  }, [playlistQuery, source.label, source.url]);

  const checkChannelAvailability = useCallback(
    () => probeIptvAvailability(matchingChannels, { sourceUrl: source.url, notify: true }),
    [matchingChannels, source.url],
  );

  const value = useMemo<IptvController>(
    () => ({
      source,
      channels,
      selectedGroup,
      keyword,
      groupOptions,
      matchingChannels,
      filteredChannels,
      availabilityFilter,
      setAvailabilityFilter,
      availabilityByUrl,
      availabilityProgress,
      availabilitySummary,
      uncheckedCount,
      hasFilters,
      isCheckingAvailability,
      playlistQuery,
      navigateHome,
      clearFilters,
      openChannel,
      updateSource,
      checkChannelAvailability,
    }),
    [
      availabilityByUrl,
      availabilityFilter,
      availabilityProgress,
      availabilitySummary,
      channels,
      checkChannelAvailability,
      clearFilters,
      filteredChannels,
      groupOptions,
      hasFilters,
      isCheckingAvailability,
      keyword,
      matchingChannels,
      navigateHome,
      openChannel,
      playlistQuery,
      selectedGroup,
      source,
      uncheckedCount,
      updateSource,
    ],
  );

  return <IptvControllerContext.Provider value={value}>{children}</IptvControllerContext.Provider>;
}

export function useIptvController(): IptvController {
  const context = useContext(IptvControllerContext);
  if (!context) {
    throw new Error("useIptvController must be used inside IptvControllerProvider");
  }
  return context;
}
