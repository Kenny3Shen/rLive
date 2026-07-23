import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invokeCmd } from "../../shared/api/tauri";
import { ErrorState } from "../../shared/components/ErrorState";
import type { HistoryItem } from "../../shared/types/live";

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function HistoryPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["history"],
    queryFn: () => invokeCmd<HistoryItem[]>("history_list"),
  });

  const clearMutation = useMutation({
    mutationFn: () => invokeCmd<void>("history_clear"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["history"] });
    },
  });

  const items = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">History</h1>
        <button
          type="button"
          disabled={items.length === 0 || clearMutation.isPending}
          onClick={() => {
            if (window.confirm("Clear all watch history?")) {
              clearMutation.mutate();
            }
          }}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
        >
          Clear
        </button>
      </div>

      {query.isLoading && (
        <p className="text-sm text-zinc-500">Loading history…</p>
      )}

      {query.isError && (
        <ErrorState
          error={query.error}
          title="Failed to load history"
          onRetry={() => void query.refetch()}
        />
      )}

      {!query.isLoading && !query.isError && items.length === 0 && (
        <p className="text-sm text-zinc-500">No watch history yet.</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {items.map((item) => (
            <li key={`${item.site_id}:${item.room_id}`}>
              <button
                type="button"
                onClick={() =>
                  navigate(
                    `/room/${item.site_id}/${encodeURIComponent(item.room_id)}`,
                  )
                }
                className="flex w-full flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
              >
                <span className="text-sm font-medium">
                  {item.title || "Untitled"}
                </span>
                <span className="text-xs text-zinc-500">
                  {item.user_name} · {item.site_id} · {formatTime(item.watched_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
