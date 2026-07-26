import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CirclePlay, Clock3, Hash, Trash2 } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { HistoryItem } from "@/shared/types/live";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { SITE_LABELS } from "@/lib/utils";

function formatTime(timestamp: number): string {
  const watchedAt = new Date(timestamp);
  if (Number.isNaN(watchedAt.getTime())) return String(timestamp);

  const elapsed = Date.now() - watchedAt.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return "刚刚";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;

  return watchedAt.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type HistoryCardProps = {
  item: HistoryItem;
  onOpen: () => void;
};

function HistoryCard({ item, onOpen }: HistoryCardProps) {
  const platform = SITE_LABELS[item.site_id] ?? item.site_id;
  const title = item.title || "未命名直播间";

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-2xl border border-border-subtle bg-card/80 p-3 text-left transition-colors hover:border-border hover:bg-card-elevated focus-ring"
    >
      <span className="relative flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted ring-1 ring-border-subtle">
        <SiteLogo siteId={item.site_id} className="size-7" />
        <CirclePlay
          className="absolute -right-1 -bottom-1 size-4 rounded-full bg-card text-muted-foreground"
          aria-hidden
        />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {item.user_name || "未知主播"}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant="outline">{platform}</Badge>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" aria-hidden />
            {formatTime(item.watched_at)}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Hash className="size-3.5" aria-hidden />
            {item.room_id}
          </span>
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
        <span className="hidden sm:inline">进入</span>
        <ChevronRight className="size-4" aria-hidden />
      </span>
    </button>
  );
}

export function HistoryPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [clearOpen, setClearOpen] = useState(false);
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);

  const query = useQuery({
    queryKey: ["history"],
    queryFn: () => invokeCmd<HistoryItem[]>("history_list"),
  });

  const clearMutation = useMutation({
    mutationFn: () => invokeCmd<void>("history_clear"),
    onSuccess: () => {
      qc.setQueryData<HistoryItem[]>(["history"], []);
      setClearOpen(false);
      void qc.invalidateQueries({ queryKey: ["history"] });
    },
  });

  const items = useMemo(
    () => (query.data ?? []).filter((item) => isSiteEnabled(item.site_id, disabledSiteIds)),
    [disabledSiteIds, query.data],
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <PageHeader
        title="观看历史"
        actions={
          <AlertDialog
            open={clearOpen}
            onOpenChange={(open) => {
              if (clearMutation.isPending) return;
              if (open) clearMutation.reset();
              setClearOpen(open);
            }}
          >
            <AlertDialogTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={items.length === 0 || clearMutation.isPending}
                >
                  <Trash2 data-icon="inline-start" />
                  清空
                </Button>
              }
            />
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogMedia className="bg-destructive/10 text-destructive">
                  <Trash2 aria-hidden />
                </AlertDialogMedia>
                <AlertDialogTitle>清空观看历史？</AlertDialogTitle>
                <AlertDialogDescription>
                  将删除全部观看记录，此操作无法恢复。
                </AlertDialogDescription>
              </AlertDialogHeader>
              {clearMutation.isError && (
                <p role="alert" className="text-sm text-destructive">
                  清空失败，请重试。
                </p>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={clearMutation.isPending}>取消</AlertDialogCancel>
                <AlertDialogAction
                  type="button"
                  variant="destructive"
                  disabled={clearMutation.isPending}
                  onClick={() => clearMutation.mutate()}
                >
                  {clearMutation.isPending ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      清空中…
                    </>
                  ) : (
                    <>
                      <Trash2 data-icon="inline-start" />
                      清空
                    </>
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
      />

      {query.isLoading && <HistorySkeleton />}

      {query.isError && (
        <ErrorState
          error={query.error}
          title="历史记录加载失败"
          onRetry={() => void query.refetch()}
        />
      )}

      {!query.isLoading && !query.isError && items.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-20 text-muted-foreground">
          <Clock3 className="size-8 opacity-40" aria-hidden />
          <p className="text-sm">暂无观看记录</p>
          <p className="text-xs">打开直播间后会自动记录</p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {items.map((item) => (
            <li key={`${item.site_id}:${item.room_id}:${item.watched_at}`}>
              <HistoryCard
                item={item}
                onOpen={() => navigate(`/room/${item.site_id}/${encodeURIComponent(item.room_id)}`)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-2xl border border-border-subtle bg-card/80 p-3"
        >
          <Skeleton className="size-12 rounded-xl" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
