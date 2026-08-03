import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CirclePlay,
  Clock3,
  Hash,
  Home,
  MessageSquareText,
  Trash2,
} from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import { isMobileClient } from "@/shared/clientPlatform";
import { enabledSiteIds, isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { DanmakuSendHistoryItem, HistoryItem, SiteId } from "@/shared/types/live";
import { historyPlatformFromSearch, HISTORY_PLATFORM_PARAM } from "./historyRoute";
import { useHistoryShellStore, type HistoryTab } from "./historyShellStore";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/components/ui/toast";
import { SITE_LABELS } from "@/lib/utils";

const HISTORY_TABS: readonly HistoryTab[] = ["watch", "danmaku"];

type HistoryDateGroup<T> = {
  key: string;
  label: string;
  items: T[];
};

type HistoryPlatformGroup<T> = {
  siteId: SiteId;
  count: number;
  dates: HistoryDateGroup<T>[];
};

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return `invalid:${timestamp}`;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function dateLabel(timestamp: number, today: number, yesterday: number): string {
  const day = startOfLocalDay(timestamp);
  if (day === today) return "今天";
  if (day === yesterday) return "昨天";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "未知日期"
    : date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

function groupHistory<T extends { site_id: SiteId }>(
  items: readonly T[],
  getTimestamp: (item: T) => number,
  platformFilter: "all" | SiteId,
  disabledSiteIds: unknown,
): HistoryPlatformGroup<T>[] {
  const visiblePlatforms = enabledSiteIds(disabledSiteIds).filter(
    (siteId) => platformFilter === "all" || siteId === platformFilter,
  );
  const byPlatform = new Map<SiteId, T[]>();
  for (const item of items) {
    if (!isSiteEnabled(item.site_id, disabledSiteIds)) continue;
    if (platformFilter !== "all" && item.site_id !== platformFilter) continue;
    const current = byPlatform.get(item.site_id) ?? [];
    current.push(item);
    byPlatform.set(item.site_id, current);
  }

  const today = startOfLocalDay(Date.now());
  const yesterday = today - 86_400_000;
  return visiblePlatforms.flatMap((siteId) => {
    const platformItems = byPlatform.get(siteId);
    if (!platformItems || platformItems.length === 0) return [];
    platformItems.sort((left, right) => getTimestamp(right) - getTimestamp(left));
    const dateMap = new Map<string, T[]>();
    for (const item of platformItems) {
      const key = dateKey(getTimestamp(item));
      const current = dateMap.get(key) ?? [];
      current.push(item);
      dateMap.set(key, current);
    }
    const dates = [...dateMap.entries()]
      .map(([key, dateItems]) => ({
        key,
        label: dateLabel(getTimestamp(dateItems[0]!), today, yesterday),
        items: dateItems,
        timestamp: getTimestamp(dateItems[0]!),
      }))
      .sort((left, right) => right.timestamp - left.timestamp)
      .map(({ key, label, items: dateItems }) => ({ key, label, items: dateItems }));
    return [{ siteId, count: platformItems.length, dates }];
  });
}

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
  onRemove: () => void;
  isRemoving: boolean;
};

function HistoryCard({ item, onOpen, onRemove, isRemoving }: HistoryCardProps) {
  const title = item.title || "未命名直播间";

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            className="group flex w-full items-center gap-3 rounded-2xl border border-border-subtle bg-card/80 p-3 text-left transition-colors hover:border-border hover:bg-card-elevated focus-ring"
          />
        }
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

        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground [@media(pointer:coarse)]:text-foreground">
          <span className="hidden sm:inline">进入</span>
          <ChevronRight className="size-4" aria-hidden />
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onClick={onOpen}>
            <CirclePlay aria-hidden />
            打开直播间
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem variant="destructive" disabled={isRemoving} onClick={onRemove}>
            <Trash2 aria-hidden />
            删除此记录
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function DanmakuSendHistoryCard({ item }: { item: DanmakuSendHistoryItem }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
            <SiteLogo siteId={item.site_id} className="size-4" />
          </span>
        </CardTitle>
        <CardAction>
          <time className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" aria-hidden />
            {formatTime(item.sent_at)}
          </time>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="break-words text-sm leading-relaxed text-foreground">{item.content}</p>
      </CardContent>
    </Card>
  );
}

type HistoryPlatformSectionsProps<T extends { site_id: SiteId }> = {
  groups: HistoryPlatformGroup<T>[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
};

function HistoryPlatformSections<T extends { site_id: SiteId }>({
  groups,
  itemKey,
  renderItem,
}: HistoryPlatformSectionsProps<T>) {
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.siteId} aria-labelledby={`history-platform-${group.siteId}`}>
          <div className="mb-2.5 flex items-center gap-2 border-b border-border-subtle pb-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
              <SiteLogo siteId={group.siteId} className="size-4" />
            </span>
            <h2
              id={`history-platform-${group.siteId}`}
              className="text-sm font-semibold text-foreground"
            >
              {SITE_LABELS[group.siteId] ?? group.siteId}
            </h2>
            <span className="text-xs text-muted-foreground">{group.count} 条</span>
          </div>
          <div className="flex flex-col gap-4">
            {group.dates.map((date) => (
              <div key={date.key}>
                <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span>{date.label}</span>
                  <span className="h-px flex-1 bg-border-subtle" />
                </h3>
                <ul className="flex flex-col gap-2.5">
                  {date.items.map((item) => (
                    <li key={itemKey(item)}>{renderItem(item)}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function HistoryPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<HistoryTab>("watch");
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const historyPlatform = historyPlatformFromSearch(
    searchParams.get(HISTORY_PLATFORM_PARAM),
    disabledSiteIds,
  );

  const watchHistoryQuery = useQuery({
    queryKey: ["history"],
    queryFn: () => invokeCmd<HistoryItem[]>("history_list"),
  });

  const danmakuSendHistoryQuery = useQuery({
    queryKey: ["danmaku-send-history", "all"],
    queryFn: () => invokeCmd<DanmakuSendHistoryItem[]>("danmaku_send_history_list_all"),
    enabled: activeTab === "danmaku",
  });

  const clearWatchHistoryMutation = useMutation({
    mutationFn: () => invokeCmd<void>("history_clear"),
    onSuccess: () => {
      qc.setQueryData<HistoryItem[]>(["history"], []);
      useHistoryShellStore.getState().setClearOpen(false);
      void qc.invalidateQueries({ queryKey: ["history"] });
    },
  });

  const clearDanmakuSendHistoryMutation = useMutation({
    mutationFn: () => invokeCmd<void>("danmaku_send_history_clear_all"),
    onSuccess: () => {
      qc.setQueriesData<DanmakuSendHistoryItem[]>({ queryKey: ["danmaku-send-history"] }, []);
      useHistoryShellStore.getState().setClearOpen(false);
      void qc.invalidateQueries({ queryKey: ["danmaku-send-history"] });
    },
  });

  const removeWatchHistoryMutation = useMutation({
    mutationFn: ({ siteId, roomId }: { siteId: HistoryItem["site_id"]; roomId: string }) =>
      invokeCmd<void>("history_remove", { siteId, roomId }),
    onSuccess: (_result, { siteId, roomId }) => {
      qc.setQueryData<HistoryItem[]>(["history"], (items) =>
        items?.filter((item) => item.site_id !== siteId || item.room_id !== roomId),
      );
      void qc.invalidateQueries({ queryKey: ["history"] });
      notify.success("已删除观看记录");
    },
    onError: () => {
      notify.error("删除观看记录失败", "请稍后重试。");
    },
  });

  const watchItems = useMemo(
    () =>
      (watchHistoryQuery.data ?? []).filter((item) => isSiteEnabled(item.site_id, disabledSiteIds)),
    [disabledSiteIds, watchHistoryQuery.data],
  );
  const danmakuSendItems = useMemo(
    () =>
      (danmakuSendHistoryQuery.data ?? []).filter((item) =>
        isSiteEnabled(item.site_id, disabledSiteIds),
      ),
    [danmakuSendHistoryQuery.data, disabledSiteIds],
  );
  const watchGroups = useMemo(
    () => groupHistory(watchItems, (item) => item.watched_at, historyPlatform, disabledSiteIds),
    [disabledSiteIds, historyPlatform, watchItems],
  );
  const danmakuGroups = useMemo(
    () => groupHistory(danmakuSendItems, (item) => item.sent_at, historyPlatform, disabledSiteIds),
    [danmakuSendItems, disabledSiteIds, historyPlatform],
  );
  const canClear =
    activeTab === "watch"
      ? (watchHistoryQuery.data?.length ?? 0) > 0
      : (danmakuSendHistoryQuery.data?.length ?? 0) > 0;
  const clearPending =
    activeTab === "watch"
      ? clearWatchHistoryMutation.isPending
      : clearDanmakuSendHistoryMutation.isPending;
  const clearError =
    activeTab === "watch"
      ? clearWatchHistoryMutation.isError
      : clearDanmakuSendHistoryMutation.isError;
  const clearTitle = activeTab === "watch" ? "清空观看历史？" : "清空发送弹幕记录？";
  const clearDescription =
    activeTab === "watch"
      ? "将删除全部观看记录，此操作无法恢复。"
      : "将删除全部已发送弹幕记录，此操作无法恢复。";

  function handleTabChange(value: string) {
    if (value !== "watch" && value !== "danmaku") return;
    const nextTab = value as HistoryTab;
    setActiveTab(nextTab);
    useHistoryShellStore.getState().setActiveTab(nextTab);
    useHistoryShellStore.getState().setClearOpen(false);
  }

  const resetActiveClearMutation = useCallback(() => {
    if (activeTab === "watch") clearWatchHistoryMutation.reset();
    else clearDanmakuSendHistoryMutation.reset();
  }, [activeTab, clearDanmakuSendHistoryMutation, clearWatchHistoryMutation]);

  const clearActiveHistory = useCallback(() => {
    if (activeTab === "watch") clearWatchHistoryMutation.mutate();
    else clearDanmakuSendHistoryMutation.mutate();
  }, [activeTab, clearDanmakuSendHistoryMutation, clearWatchHistoryMutation]);

  const historyTabSwipe = useHorizontalSwipe({
    items: HISTORY_TABS,
    value: activeTab,
    onChange: (tab) => handleTabChange(tab),
    enabled: isMobileClient(),
  });

  const refreshActiveHistory = () =>
    activeTab === "watch" ? watchHistoryQuery.refetch() : danmakuSendHistoryQuery.refetch();
  const historyRefreshing =
    activeTab === "watch" ? watchHistoryQuery.isRefetching : danmakuSendHistoryQuery.isRefetching;

  useEffect(() => {
    const shell = useHistoryShellStore.getState();
    shell.register({
      activeTab,
      canClear,
      clearPending,
      clearError,
      clearTitle,
      clearDescription,
      resetActiveMutation: resetActiveClearMutation,
      clearActiveHistory,
    });
    return () => useHistoryShellStore.getState().reset();
  }, [
    activeTab,
    canClear,
    clearActiveHistory,
    clearDescription,
    clearError,
    clearPending,
    clearTitle,
    resetActiveClearMutation,
  ]);

  return (
    <PullToRefresh
      onRefresh={refreshActiveHistory}
      refreshing={historyRefreshing}
      className="mx-auto max-w-3xl"
      onPointerDownCapture={historyTabSwipe.onPointerDownCapture}
      onPointerMoveCapture={historyTabSwipe.onPointerMoveCapture}
      onPointerUpCapture={historyTabSwipe.onPointerUpCapture}
      onPointerCancelCapture={historyTabSwipe.onPointerCancelCapture}
      onClickCapture={historyTabSwipe.onClickCapture}
    >
      <RefreshFab
        onRefresh={refreshActiveHistory}
        pending={
          historyRefreshing ||
          (activeTab === "watch" ? watchHistoryQuery.isLoading : danmakuSendHistoryQuery.isLoading)
        }
        label="刷新历史记录"
      />
      <div className="flex min-h-full flex-col gap-4 touch-pan-y">
        <PageHeader title="历史记录" />

        <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-4">
          <TabsList
            aria-label="历史记录类型"
            className="grid h-11! w-full grid-cols-2 rounded-xl border border-border-subtle bg-card/60 p-1 max-md:h-12! max-md:min-h-12 max-md:p-0.5 sm:w-fit"
          >
            <TabsTrigger value="watch" className="h-9! min-w-0 gap-2 px-3 max-md:h-11!">
              <Clock3 aria-hidden />
              观看历史
            </TabsTrigger>
            <TabsTrigger value="danmaku" className="h-9! min-w-0 gap-2 px-3 max-md:h-11!">
              <MessageSquareText aria-hidden />
              发送弹幕
            </TabsTrigger>
          </TabsList>

          <TabsContent value="watch" className="mt-0">
            {watchHistoryQuery.isLoading && <HistorySkeleton />}

            {watchHistoryQuery.isError && (
              <ErrorState
                error={watchHistoryQuery.error}
                title="观看历史加载失败"
                onRetry={() => void watchHistoryQuery.refetch()}
              />
            )}

            {!watchHistoryQuery.isLoading &&
              !watchHistoryQuery.isError &&
              watchGroups.length === 0 && (
                <Empty className="min-h-64 py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Clock3 aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>暂无观看记录</EmptyTitle>
                    <EmptyDescription>打开直播间后会自动记录在这里。</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" size="sm" onClick={() => navigate("/")}>
                      <Home data-icon="inline-start" aria-hidden />
                      去首页看看
                    </Button>
                  </EmptyContent>
                </Empty>
              )}

            {watchGroups.length > 0 && (
              <HistoryPlatformSections
                groups={watchGroups}
                itemKey={(item) => `${item.site_id}:${item.room_id}:${item.watched_at}`}
                renderItem={(item) => (
                  <HistoryCard
                    item={item}
                    onOpen={() =>
                      navigate(`/room/${item.site_id}/${encodeURIComponent(item.room_id)}`)
                    }
                    onRemove={() =>
                      removeWatchHistoryMutation.mutate({
                        siteId: item.site_id,
                        roomId: item.room_id,
                      })
                    }
                    isRemoving={removeWatchHistoryMutation.isPending}
                  />
                )}
              />
            )}
          </TabsContent>

          <TabsContent value="danmaku" className="mt-0">
            {danmakuSendHistoryQuery.isLoading && <DanmakuSendHistorySkeleton />}

            {danmakuSendHistoryQuery.isError && (
              <ErrorState
                error={danmakuSendHistoryQuery.error}
                title="发送弹幕记录加载失败"
                onRetry={() => void danmakuSendHistoryQuery.refetch()}
              />
            )}

            {!danmakuSendHistoryQuery.isLoading &&
              !danmakuSendHistoryQuery.isError &&
              danmakuGroups.length === 0 && (
                <Empty className="min-h-64 py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessageSquareText aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>暂无发送弹幕记录</EmptyTitle>
                    <EmptyDescription>成功发送的弹幕会保存在此设备上。</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}

            {danmakuGroups.length > 0 && (
              <HistoryPlatformSections
                groups={danmakuGroups}
                itemKey={(item) => `${item.site_id}:${item.sent_at}:${item.content}`}
                renderItem={(item) => <DanmakuSendHistoryCard item={item} />}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </PullToRefresh>
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

function DanmakuSendHistorySkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 5 }).map((_, index) => (
        <Card key={index} size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Skeleton className="size-7 rounded-lg" />
              <Skeleton className="h-5 w-12 rounded-full" />
            </CardTitle>
            <CardAction>
              <Skeleton className="h-3 w-16" />
            </CardAction>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-4/5" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
