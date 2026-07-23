import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  Star,
  UserRoundX,
  Radio,
} from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { Chip } from "@/shared/components/Chip";
import { PageHeader } from "@/shared/components/PageHeader";
import type { FollowUser } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, SITE_LABELS } from "@/lib/utils";

type TagRecord = { id: string; name: string };
type LiveFilter = "all" | "live" | "offline";
type SortMode = "status" | "platform";

export function FollowPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tagFilter, setTagFilter] = useState<string | "all">("all");
  const [liveFilter, setLiveFilter] = useState<LiveFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("status");
  const [onlyLiveChip, setOnlyLiveChip] = useState(false);

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
    let list = [...(followsQuery.data ?? [])];
    if (tagFilter !== "all") {
      list = list.filter((f) => f.tag_ids.includes(tagFilter));
    }
    const effectiveLive = onlyLiveChip ? "live" : liveFilter;
    if (effectiveLive === "live") {
      list = list.filter((f) => f.live_status === true);
    } else if (effectiveLive === "offline") {
      list = list.filter((f) => f.live_status === false);
    }
    if (sortMode === "status") {
      list.sort((a, b) => {
        const av = a.live_status === true ? 0 : a.live_status === false ? 1 : 2;
        const bv = b.live_status === true ? 0 : b.live_status === false ? 1 : 2;
        if (av !== bv) return av - bv;
        return a.user_name.localeCompare(b.user_name, "zh");
      });
    } else {
      list.sort((a, b) => {
        if (a.site_id !== b.site_id) return a.site_id.localeCompare(b.site_id);
        return a.user_name.localeCompare(b.user_name, "zh");
      });
    }
    return list;
  }, [followsQuery.data, tagFilter, liveFilter, onlyLiveChip, sortMode]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="关注用户"
        actions={
          <Button
            variant="secondary"
            size="icon"
            disabled={refreshMutation.isPending}
            onClick={() => refreshMutation.mutate()}
            title="刷新开播状态"
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",
                refreshMutation.isPending && "animate-spin-soft",
              )}
            />
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Chip
          active={onlyLiveChip}
          onClick={() => setOnlyLiveChip((v) => !v)}
          onClear={onlyLiveChip ? () => setOnlyLiveChip(false) : undefined}
        >
          仅显示开播
        </Chip>
        <Chip
          active={sortMode === "status"}
          onClick={() => setSortMode("status")}
        >
          按状态
        </Chip>
        <Chip
          active={sortMode === "platform"}
          onClick={() => setSortMode("platform")}
        >
          按平台
        </Chip>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["all", "全部"],
            ["live", "直播中"],
            ["offline", "未开播"],
          ] as const
        ).map(([key, label]) => (
          <Chip
            key={key}
            active={!onlyLiveChip && liveFilter === key}
            onClick={() => {
              setOnlyLiveChip(false);
              setLiveFilter(key);
            }}
          >
            {label}
          </Chip>
        ))}
        {(tagsQuery.data?.length ?? 0) > 0 && (
          <>
            <span className="mx-1 h-4 w-px bg-border" />
            <Chip
              active={tagFilter === "all"}
              onClick={() => setTagFilter("all")}
            >
              全部标签
            </Chip>
            {tagsQuery.data?.map((t) => (
              <Chip
                key={t.id}
                active={tagFilter === t.id}
                onClick={() => setTagFilter(t.id)}
              >
                {t.name}
              </Chip>
            ))}
          </>
        )}
      </div>

      {followsQuery.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] w-full rounded-2xl" />
          ))}
        </div>
      )}

      {followsQuery.isError && (
        <ErrorState
          error={followsQuery.error}
          title="关注列表加载失败"
          onRetry={() => void followsQuery.refetch()}
        />
      )}

      {!followsQuery.isLoading && items.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-muted-foreground">
          <Star className="h-8 w-8 opacity-40" />
          <p className="text-sm">还没有关注任何主播</p>
          <p className="text-xs">打开直播间后点击「关注」即可添加</p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="space-y-2.5">
          {items.map((u) => {
            const live = u.live_status === true;
            const offline = u.live_status === false;
            return (
              <li key={`${u.site_id}:${u.room_id}`}>
                <div
                  className={cn(
                    "group flex items-center gap-3 rounded-2xl border border-border-subtle bg-card/80 p-2.5 pr-3 transition-colors",
                    "hover:border-border hover:bg-card-elevated",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left focus-ring rounded-xl"
                    onClick={() =>
                      navigate(
                        `/room/${u.site_id}/${encodeURIComponent(u.room_id)}`,
                      )
                    }
                  >
                    <div className="relative h-16 w-[104px] shrink-0 overflow-hidden rounded-xl bg-muted">
                      {u.face ? (
                        <img
                          src={u.face}
                          alt=""
                          className="h-full w-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center">
                          <Radio className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                      {live && (
                        <Badge
                          className="absolute left-1.5 top-1.5 animate-live bg-accent text-accent-foreground"
                        >
                          直播中
                        </Badge>
                      )}
                    </div>

                    <div className="relative min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {u.face ? (
                          <img
                            src={u.face}
                            alt=""
                            className="h-8 w-8 rounded-full object-cover ring-2 ring-background"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="h-8 w-8 rounded-full bg-muted" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {u.user_name}
                            {live && (
                              <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-success align-middle" />
                            )}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {SITE_LABELS[u.site_id] ?? u.site_id} · 房间{" "}
                            {u.room_id}
                          </p>
                        </div>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">
                          {SITE_LABELS[u.site_id] ?? u.site_id}
                        </Badge>
                        {live && (
                          <Badge className="bg-success/15 text-success">
                            直播中
                          </Badge>
                        )}
                        {offline && <Badge>未开播</Badge>}
                        {u.live_status == null && <Badge>未知</Badge>}
                      </div>
                    </div>
                  </button>

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 opacity-60 hover:opacity-100 hover:text-danger"
                    title="取消关注"
                    onClick={() => removeMutation.mutate(u)}
                  >
                    <UserRoundX className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
