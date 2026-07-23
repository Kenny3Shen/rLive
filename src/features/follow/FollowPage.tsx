import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invokeCmd } from "../../shared/api/tauri";
import { ErrorState } from "../../shared/components/ErrorState";
import type { FollowUser } from "../../shared/types/live";

type TagRecord = { id: string; name: string };

export function FollowPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tagFilter, setTagFilter] = useState<string | "all">("all");

  const followsQuery = useQuery({
    queryKey: ["follows"],
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
  });

  const tagsQuery = useQuery({
    queryKey: ["tags"],
    queryFn: () => invokeCmd<TagRecord[]>("tag_list"),
  });

  const refreshMutation = useMutation({
    mutationFn: () => invokeCmd<FollowUser[]>("follow_refresh"),
    onSuccess: (data) => {
      qc.setQueryData(["follows"], data);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (u: FollowUser) =>
      invokeCmd("follow_remove", {
        siteId: u.site_id,
        roomId: u.room_id,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["follows"] });
    },
  });

  const items = useMemo(() => {
    const list = followsQuery.data ?? [];
    if (tagFilter === "all") return list;
    return list.filter((f) => f.tag_ids.includes(tagFilter));
  }, [followsQuery.data, tagFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Follow</h1>
        <button
          type="button"
          disabled={refreshMutation.isPending}
          onClick={() => refreshMutation.mutate()}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {refreshMutation.isPending ? "Refreshing…" : "Refresh live"}
        </button>
      </div>

      {(tagsQuery.data?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setTagFilter("all")}
            className={
              tagFilter === "all"
                ? "rounded-md bg-zinc-900 px-2.5 py-1 text-xs text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "rounded-md bg-zinc-100 px-2.5 py-1 text-xs dark:bg-zinc-800"
            }
          >
            All
          </button>
          {tagsQuery.data?.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTagFilter(t.id)}
              className={
                tagFilter === t.id
                  ? "rounded-md bg-zinc-900 px-2.5 py-1 text-xs text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "rounded-md bg-zinc-100 px-2.5 py-1 text-xs dark:bg-zinc-800"
              }
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {followsQuery.isLoading && (
        <p className="text-sm text-zinc-500">Loading follows…</p>
      )}

      {followsQuery.isError && (
        <ErrorState
          error={followsQuery.error}
          title="Failed to load follows"
          onRetry={() => void followsQuery.refetch()}
        />
      )}

      {!followsQuery.isLoading && items.length === 0 && (
        <p className="text-sm text-zinc-500">
          No follows yet. Open a room and click Follow.
        </p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {items.map((u) => (
            <li
              key={`${u.site_id}:${u.room_id}`}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() =>
                  navigate(
                    `/room/${u.site_id}/${encodeURIComponent(u.room_id)}`,
                  )
                }
              >
                {u.face ? (
                  <img
                    src={u.face}
                    alt=""
                    className="h-10 w-10 rounded-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-zinc-200 dark:bg-zinc-800" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{u.user_name}</p>
                  <p className="text-xs text-zinc-500">
                    {u.site_id} · {u.room_id}
                    {u.live_status === true && (
                      <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                        Live
                      </span>
                    )}
                    {u.live_status === false && (
                      <span className="ml-2 text-zinc-400">Offline</span>
                    )}
                    {u.live_status == null && (
                      <span className="ml-2 text-zinc-400">Unknown</span>
                    )}
                  </p>
                </div>
              </button>
              <button
                type="button"
                className="shrink-0 text-xs text-zinc-500 hover:text-red-600"
                onClick={() => removeMutation.mutate(u)}
              >
                Unfollow
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
