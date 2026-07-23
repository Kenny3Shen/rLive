import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Trash2 } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import type { HistoryItem } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SITE_LABELS } from "@/lib/utils";

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
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="观看历史"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={items.length === 0 || clearMutation.isPending}
            onClick={() => {
              if (window.confirm("确定清空全部观看历史？")) {
                clearMutation.mutate();
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            清空
          </Button>
        }
      />

      {query.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      )}

      {query.isError && (
        <ErrorState
          error={query.error}
          title="历史记录加载失败"
          onRetry={() => void query.refetch()}
        />
      )}

      {!query.isLoading && !query.isError && items.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-20 text-muted-foreground">
          <Clock className="h-8 w-8 opacity-40" />
          <p className="text-sm">还没有观看记录</p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={`${item.site_id}:${item.room_id}:${item.watched_at}`}>
              <button
                type="button"
                onClick={() =>
                  navigate(
                    `/room/${item.site_id}/${encodeURIComponent(item.room_id)}`,
                  )
                }
                className="flex w-full flex-col gap-0.5 rounded-xl border border-transparent px-3.5 py-3 text-left transition-colors hover:border-border-subtle hover:bg-card focus-ring"
              >
                <span className="text-sm font-medium">
                  {item.title || "未命名直播间"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.user_name} ·{" "}
                  {SITE_LABELS[item.site_id] ?? item.site_id} ·{" "}
                  {formatTime(item.watched_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
