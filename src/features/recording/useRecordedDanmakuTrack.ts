import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  filterRecordedDanmakuEntries,
  parseRecordedDanmakuSidecar,
  type RecordedDanmakuEntry,
} from "./recordedDanmaku";
import { recordingDanmakuUrl, type RecordingItem } from "./recording";

const EMPTY_ENTRIES: RecordedDanmakuEntry[] = [];
const MISSING_TRACK_ERROR = new Error("录制弹幕文件不存在或无法读取");

/**
 * 一段录制的完整弹幕轨。画布和侧栏共享同一次 URL 查询与 sidecar 解析；
 * 过滤在提升到页面后只做一次，两个视图看到的条目集合保持一致。
 */
export function useRecordedDanmakuTrack(item: RecordingItem | null) {
  const included = Boolean(item?.include_danmaku);
  const filterGifts = useSettingsStore((state) => state.danmakuFilterGifts);
  const showSuperChat = useSettingsStore((state) => state.superChatEnabled);
  const shieldWords = useSettingsStore((state) => state.danmakuShieldWords);
  const blockedUsers = useSettingsStore((state) => state.danmakuBlockedUsers);

  const urlQuery = useQuery({
    queryKey: ["recording-danmaku", item?.id ?? ""],
    enabled: included && Boolean(item?.id),
    queryFn: () => recordingDanmakuUrl(item!.id),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const url = urlQuery.data ?? null;
  const entriesQuery = useQuery({
    queryKey: ["recording-danmaku-entries", item?.id ?? "", url ?? ""],
    enabled: included && Boolean(url),
    queryFn: async ({ signal }) => {
      const response = await fetch(url!, { signal });
      if (!response.ok) throw new Error("弹幕轨读取失败");
      return parseRecordedDanmakuSidecar(await response.text());
    },
    gcTime: 0,
    retry: false,
  });

  const entries = useMemo(
    () =>
      filterRecordedDanmakuEntries(entriesQuery.data ?? EMPTY_ENTRIES, {
        filterGifts,
        showSuperChat,
        shieldWords,
        blockedUsers,
      }),
    [blockedUsers, entriesQuery.data, filterGifts, shieldWords, showSuperChat],
  );
  const loading = included && (urlQuery.isPending || (Boolean(url) && entriesQuery.isPending));
  const error =
    urlQuery.error ??
    entriesQuery.error ??
    (included && urlQuery.isSuccess && !url ? MISSING_TRACK_ERROR : null);
  const refetch = useCallback(() => {
    if (urlQuery.isError || !urlQuery.data) void urlQuery.refetch();
    else void entriesQuery.refetch();
  }, [entriesQuery, urlQuery]);

  return {
    included,
    available: Boolean(url),
    entries,
    loading,
    error,
    refetch,
  };
}
