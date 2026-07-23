import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invokeCmd } from "../../shared/api/tauri";
import { ErrorState } from "../../shared/components/ErrorState";
import type {
  HistoryItem,
  LivePlayQuality,
  LiveRoomDetail,
  PlayUrl,
  SiteId,
} from "../../shared/types/live";
import { PlayerPane } from "./PlayerPane";

function formatOnline(n: number): string {
  if (n >= 10_000) {
    const w = n / 10_000;
    return `${w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, "")}万`;
  }
  return String(n);
}

export function RoomPage() {
  const { siteId: siteParam, roomId: roomParam } = useParams<{
    siteId: string;
    roomId: string;
  }>();
  const siteId = siteParam as SiteId | undefined;
  const roomId = roomParam ? decodeURIComponent(roomParam) : undefined;

  const [qualityIndex, setQualityIndex] = useState(0);

  const detailQuery = useQuery({
    queryKey: ["room_detail", siteId, roomId],
    enabled: !!siteId && !!roomId,
    queryFn: () =>
      invokeCmd<LiveRoomDetail>("site_get_room_detail", {
        siteId,
        roomId,
      }),
  });

  // Record history once detail loads successfully.
  useEffect(() => {
    const detail = detailQuery.data;
    if (!detail) return;
    const item: HistoryItem = {
      site_id: detail.site_id,
      room_id: detail.room_id,
      title: detail.title,
      user_name: detail.user_name,
      watched_at: Date.now(),
    };
    void invokeCmd("history_add", { item }).catch(() => {
      // Non-fatal: room still usable without history write.
    });
  }, [detailQuery.data]);

  const qualitiesQuery = useQuery({
    queryKey: ["play_qualities", siteId, roomId, detailQuery.data?.room_id],
    enabled: !!detailQuery.data,
    queryFn: () =>
      invokeCmd<LivePlayQuality[]>("site_get_play_qualities", {
        siteId,
        detail: detailQuery.data,
      }),
  });

  // Reset quality selection when qualities list changes.
  useEffect(() => {
    setQualityIndex(0);
  }, [qualitiesQuery.data]);

  const selectedQuality: LivePlayQuality | null = useMemo(() => {
    const list = qualitiesQuery.data;
    if (!list || list.length === 0) return null;
    return list[Math.min(qualityIndex, list.length - 1)] ?? null;
  }, [qualitiesQuery.data, qualityIndex]);

  const playUrlQuery = useQuery({
    queryKey: [
      "play_urls",
      siteId,
      roomId,
      selectedQuality?.quality,
      selectedQuality?.data,
    ],
    enabled: !!detailQuery.data && !!selectedQuality,
    queryFn: () =>
      invokeCmd<PlayUrl[]>("site_get_play_urls", {
        siteId,
        detail: detailQuery.data,
        quality: selectedQuality,
      }),
  });

  const playUrl = playUrlQuery.data?.[0] ?? null;

  const retryPlay = useCallback(() => {
    void qualitiesQuery.refetch().then(() => playUrlQuery.refetch());
  }, [qualitiesQuery, playUrlQuery]);

  if (!siteId || !roomId) {
    return (
      <ErrorState
        error={{ code: "bad_route", message: "Missing site or room id", site: null, retryable: false }}
        title="Invalid room link"
      />
    );
  }

  const detail = detailQuery.data;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex items-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
        <Link to="/" className="hover:text-zinc-800 dark:hover:text-zinc-200">
          ← Home
        </Link>
        <span className="text-zinc-300 dark:text-zinc-600">/</span>
        <span className="font-mono text-xs">
          {siteId}/{roomId}
        </span>
      </div>

      {detailQuery.isLoading && (
        <p className="text-sm text-zinc-500">Loading room…</p>
      )}

      {detailQuery.isError && (
        <ErrorState
          error={detailQuery.error}
          title="Failed to load room"
          onRetry={() => void detailQuery.refetch()}
        />
      )}

      {detail && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h1 className="text-xl font-semibold leading-snug sm:text-2xl">
                {detail.title || "Untitled room"}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">
                  {detail.user_name}
                </span>
                <span>·</span>
                <span>{formatOnline(detail.online)} online</span>
                <span
                  className={
                    detail.status
                      ? "rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : "rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  }
                >
                  {detail.status ? "Live" : "Offline"}
                </span>
              </div>
              {detail.notice && (
                <p className="max-w-3xl text-xs text-zinc-500 line-clamp-2">
                  {detail.notice}
                </p>
              )}
            </div>

            {qualitiesQuery.data && qualitiesQuery.data.length > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-zinc-500">Quality</span>
                <select
                  value={qualityIndex}
                  onChange={(e) => setQualityIndex(Number(e.target.value))}
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {qualitiesQuery.data.map((q, i) => (
                    <option key={`${q.quality}-${i}`} value={i}>
                      {q.quality}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </header>

          <PlayerPane
            playUrl={playUrl}
            loading={
              qualitiesQuery.isLoading ||
              (qualitiesQuery.isSuccess && playUrlQuery.isLoading)
            }
            error={
              qualitiesQuery.isError
                ? qualitiesQuery.error
                : playUrlQuery.isError
                  ? playUrlQuery.error
                  : qualitiesQuery.isSuccess &&
                      playUrlQuery.isSuccess &&
                      !playUrl
                    ? {
                        code: "no_play_url",
                        message: "No playable URL returned for this quality",
                        site: siteId,
                        retryable: true,
                      }
                    : undefined
            }
            onRetry={retryPlay}
            title={detail.title}
          />
        </>
      )}
    </div>
  );
}
