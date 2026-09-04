import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CirclePlay,
  Clock3,
  Hash,
  Home,
  MessageSquareText,
  MonitorPlay,
  Radio,
  SearchX,
  Trash2,
  UserRound,
} from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import { isMobileClient } from "@/shared/clientPlatform";
import { enabledSiteIds } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import type { DanmakuSendHistoryItem, HistoryItem } from "@/shared/types/live";
import type { VideoHistoryItem, VideoHistoryKind } from "@/shared/types/video";
import {
  VIDEO_HISTORY_QUERY_KEY,
  formatVideoDuration,
  videoHistoryClear,
  videoHistoryList,
  videoHistoryPlayPath,
  videoHistoryRemove,
} from "@/features/video/videoHistory";
import {
  filterHistoryBySite,
  groupHistoryByDate,
  type HistoryDateGroup,
  type HistoryPlatformFilter,
} from "./historyGrouping";
import {
  HISTORY_DATE_PARAM,
  HISTORY_PLATFORM_PARAM,
  HISTORY_QUERY_PARAM,
  type HistoryDateFilter,
  filterHistoryItems,
  historyDateFilterFromSearch,
  historyPlatformFilterFromSearch,
  withHistoryDateFilter,
  withHistoryPlatformFilter,
  withHistorySearch,
} from "./historyFilter";
import {
  HISTORY_VIEW_PARAM,
  HISTORY_VIEWS,
  type HistoryView,
  historyViewFromSearch,
  withHistoryView,
} from "./historyRoute";
import {
  HistoryDateFilterControl,
  HistoryPlatformFilterControl,
  HistorySearchInput,
} from "./HistoryHeaderControls";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { notify } from "@/components/ui/toast";
import { preloadRouteModule } from "@/app/routeModules";
import { useHistoryHeaderState } from "./historyHeaderState";

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

/** 每个视图的清空确认文案。 */
const CLEAR_CONFIRM_COPY: Record<HistoryView, { title: string; description: string }> = {
  watch: { title: "清空观看历史？", description: "将删除全部观看记录，此操作无法恢复。" },
  video: { title: "清空视频历史？", description: "将删除全部视频观看记录，此操作无法恢复。" },
  danmaku: {
    title: "清空弹幕历史？",
    description: "将删除全部已发送弹幕记录，此操作无法恢复。",
  },
};

type HistoryCardProps = {
  item: HistoryItem;
  onOpen: () => void;
  onRemove: () => void;
  isRemoving: boolean;
};

function HistoryCard({ item, onOpen, onRemove, isRemoving }: HistoryCardProps) {
  const title = item.title || "未命名直播间";
  const roomPath = `/room/${item.site_id}/${encodeURIComponent(item.room_id)}`;
  // 早于封面列出现写入的记录，以及从不提供封面的平台，
  // 回退到平台标识而不是空盒子。
  const cover = normalizeImageUrl(item.cover);

  // 这里不放上下文菜单，也不响应触摸长按：点按打开房间、删除按钮覆盖了仅剩的操作，
  // 右键/长按菜单只会在每张卡上重复这两个功能。
  return (
    <div
      role="button"
      data-motion-press
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={(event) => {
        // 拦下 Android WebView 长按派发的原生图片/文本菜单，
        // 让历史卡片在触摸设备上彻底不可长按。
        if (isMobileClient()) event.preventDefault();
      }}
      onPointerEnter={() => preloadRouteModule(roomPath)}
      onPointerDown={() => preloadRouteModule(roomPath)}
      onFocus={() => preloadRouteModule(roomPath)}
      className="group flex w-full items-center gap-3 rounded-2xl border border-border-subtle bg-card/80 p-3 text-left transition-colors hover:border-border hover:bg-card-elevated focus-ring"
    >
      <span className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-xl bg-muted ring-1 ring-border-subtle max-sm:w-20">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center">
            <SiteLogo siteId={item.site_id} className="size-7" />
          </span>
        )}
        {/* 让平台标识在任何亮度的封面上都保持可读。 */}
        <span className="absolute bottom-1 left-1 flex size-5 items-center justify-center rounded-md bg-black/60 backdrop-blur-sm">
          <SiteLogo siteId={item.site_id} className="size-3.5" />
        </span>
        <CirclePlay
          className="absolute right-1 bottom-1 size-4 rounded-full bg-card/85 text-foreground/80"
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

      <Button
        type="button"
        variant="destructive"
        size="icon-sm"
        data-action="delete-history"
        aria-label={`删除 ${title} 的观看记录`}
        title="删除此记录"
        disabled={isRemoving}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
      >
        {isRemoving ? <Spinner aria-hidden /> : <Trash2 aria-hidden />}
      </Button>
    </div>
  );
}

type VideoHistoryCardProps = {
  item: VideoHistoryItem;
  onOpen: () => void;
  onRemove: () => void;
  isRemoving: boolean;
};

/**
 * 一条视频观看记录。与直播历史卡同构（封面 + 文本列 + 删除按钮），
 * 额外在封面上叠时长标签与进度条 —— 用户要判断「上次看到哪儿了」，
 * 进度是这张卡与直播卡唯一的语义差别。
 */
function VideoHistoryCard({ item, onOpen, onRemove, isRemoving }: VideoHistoryCardProps) {
  const title = item.title || "未命名视频";
  const playPath = videoHistoryPlayPath(item);
  const cover = normalizeImageUrl(item.cover);
  // 副行优先分集标题：番剧没有作者，分集名才是这一行唯一有信息量的内容。
  const subtitle = item.part_title || item.author;
  const hasDuration = item.duration > 0;
  const progressPercent = hasDuration
    ? Math.min(100, Math.max(0, (item.progress / item.duration) * 100))
    : 0;
  const watched = formatVideoDuration(item.progress);
  // 总时长未知时只报已看到多少：`已看到 3:20 / 0:00` 会读成「一共零秒」。
  const progressLabel = hasDuration
    ? `已看到 ${watched} / ${formatVideoDuration(item.duration)}`
    : `已看到 ${watched}`;

  return (
    <div
      role="button"
      data-motion-press
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={(event) => {
        if (isMobileClient()) event.preventDefault();
      }}
      onPointerEnter={() => preloadRouteModule(playPath)}
      onPointerDown={() => preloadRouteModule(playPath)}
      onFocus={() => preloadRouteModule(playPath)}
      className="group flex w-full items-center gap-3 rounded-2xl border border-border-subtle bg-card/80 p-3 text-left transition-colors hover:border-border hover:bg-card-elevated focus-ring"
    >
      <span className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-xl bg-muted ring-1 ring-border-subtle max-sm:w-20">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center">
            <MonitorPlay className="size-6 text-muted-foreground" aria-hidden />
          </span>
        )}
        {hasDuration && (
          <>
            <span className="absolute right-1 bottom-1.5 rounded-md bg-black/60 px-1 text-[10px] leading-4 font-medium text-white backdrop-blur-sm">
              {formatVideoDuration(item.duration)}
            </span>
            {/* 进度条压在封面底边：它是缩略图的一部分，不占文本列的行。 */}
            <span className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
              <span className="block h-full bg-primary" style={{ width: `${progressPercent}%` }} />
            </span>
          </>
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {subtitle || "未知作者"}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" aria-hidden />
            {formatTime(item.watched_at)}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {progressLabel}
          </span>
        </span>
      </span>

      <Button
        type="button"
        variant="destructive"
        size="icon-sm"
        data-action="delete-history"
        aria-label={`删除 ${title} 的观看记录`}
        title="删除此记录"
        disabled={isRemoving}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
      >
        {isRemoving ? <Spinner aria-hidden /> : <Trash2 aria-hidden />}
      </Button>
    </div>
  );
}

/** 消息发往的房间；不可得时用纯平台标签。 */
function danmakuRoomLabel(item: DanmakuSendHistoryItem): string {
  const title = item.room_title?.trim();
  if (title) return title;
  const roomId = item.room_id?.trim();
  if (roomId) return `房间 ${roomId}`;
  return SITE_LABELS[item.site_id] ?? item.site_id;
}

function DanmakuSendHistoryCard({
  item,
  onOpenRoom,
}: {
  item: DanmakuSendHistoryItem;
  onOpenRoom?: () => void;
}) {
  const roomLabel = danmakuRoomLabel(item);
  const roomId = item.room_id?.trim();
  const roomUserName = item.room_user_name?.trim();

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
            <SiteLogo siteId={item.site_id} className="size-4" />
          </span>
          {/* 消息发往哪个房间正是这一行的重点，
              因此它是卡片标题而不是内容下的脚注。 */}
          {roomId && onOpenRoom ? (
            <button
              type="button"
              onClick={onOpenRoom}
              title={`打开 ${roomLabel}`}
              className="inline-flex min-w-0 items-center gap-1 rounded-md text-sm font-medium text-foreground transition-colors hover:text-primary focus-ring"
            >
              <Radio className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{roomLabel}</span>
            </button>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1 text-sm font-medium text-muted-foreground">
              <Radio className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{roomLabel}</span>
            </span>
          )}
        </CardTitle>
        <CardAction>
          <time className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
            <Clock3 className="size-3.5" aria-hidden />
            {formatTime(item.sent_at)}
          </time>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="break-words text-sm leading-relaxed text-foreground">{item.content}</p>
        {(roomUserName || roomId) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {roomUserName && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <UserRound className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{roomUserName}</span>
              </span>
            )}
            {roomId && (
              <span className="inline-flex items-center gap-1">
                <Hash className="size-3.5" aria-hidden />
                {roomId}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 与条目形态无关：只用 `itemKey`/`renderItem`，因此视频历史（无 `site_id`）也能复用。 */
type HistoryTimelineProps<T> = {
  groups: HistoryDateGroup<T>[];
  headingIdPrefix: string;
  itemKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
};

function HistoryTimeline<T>({
  groups,
  headingIdPrefix,
  itemKey,
  renderItem,
}: HistoryTimelineProps<T>) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group, index) => (
        <section key={group.key} aria-labelledby={`${headingIdPrefix}-${index}`}>
          <h2
            id={`${headingIdPrefix}-${index}`}
            className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground"
          >
            <span>{group.label}</span>
            <span className="h-px flex-1 bg-border-subtle" />
          </h2>
          <ul className="flex flex-col gap-2.5">
            {group.items.map((item) => (
              <li key={itemKey(item)}>{renderItem(item)}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function HistoryFilteredEmpty({ onReset }: { onReset: () => void }) {
  return (
    <Empty className="min-h-64 py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>没有匹配的记录</EmptyTitle>
        <EmptyDescription>调整平台、关键词或日期范围后重试。</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onReset}>
          清除筛选条件
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function HistoryPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [clearOpen, setClearOpen] = useState(false);
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const visibleSiteIds = useMemo(() => enabledSiteIds(disabledSiteIds), [disabledSiteIds]);
  const activeView = historyViewFromSearch(searchParams.get(HISTORY_VIEW_PARAM));
  const keyword = searchParams.get(HISTORY_QUERY_PARAM) ?? "";
  const dateFilter = historyDateFilterFromSearch(searchParams.get(HISTORY_DATE_PARAM));
  const requestedPlatform = historyPlatformFilterFromSearch(
    searchParams.get(HISTORY_PLATFORM_PARAM),
  );
  const platformFilter =
    requestedPlatform === "all" || visibleSiteIds.includes(requestedPlatform)
      ? requestedPlatform
      : "all";
  // 视频历史只有 B 站一个来源，平台筛选对它不适用：把它算进去会让用户在直播视图
  // 设过平台后，切到视频视图看到「没有匹配的记录」而不是真空态。
  const hasTextFilters = keyword.trim().length > 0 || dateFilter !== "all";
  const hasFilters =
    activeView === "video" ? hasTextFilters : hasTextFilters || platformFilter !== "all";

  const allWatchHistoryQuery = useQuery({
    queryKey: ["history", "all"],
    queryFn: () =>
      invokeCmd<HistoryItem[]>("history_list", {
        siteId: null,
      }),
  });
  const platformWatchHistoryQuery = useQuery({
    queryKey: ["history", "platform", platformFilter],
    queryFn: () =>
      invokeCmd<HistoryItem[]>("history_list", {
        siteId: platformFilter === "all" ? null : platformFilter,
      }),
    enabled: platformFilter !== "all",
  });
  const watchHistoryQuery =
    platformFilter === "all" ? allWatchHistoryQuery : platformWatchHistoryQuery;

  const danmakuSendHistoryQuery = useQuery({
    queryKey: ["danmaku-send-history", "all"],
    queryFn: () => invokeCmd<DanmakuSendHistoryItem[]>("danmaku_send_history_list_all"),
    enabled: activeView === "danmaku",
  });

  const videoHistoryQuery = useQuery({
    queryKey: VIDEO_HISTORY_QUERY_KEY,
    queryFn: videoHistoryList,
    enabled: activeView === "video",
  });

  const clearWatchHistoryMutation = useMutation({
    mutationFn: () => invokeCmd<void>("history_clear"),
    onSuccess: () => {
      qc.setQueriesData<HistoryItem[]>({ queryKey: ["history"] }, []);
      setClearOpen(false);
      void qc.invalidateQueries({ queryKey: ["history"] });
    },
  });

  const clearDanmakuSendHistoryMutation = useMutation({
    mutationFn: () => invokeCmd<void>("danmaku_send_history_clear_all"),
    onSuccess: () => {
      qc.setQueriesData<DanmakuSendHistoryItem[]>({ queryKey: ["danmaku-send-history"] }, []);
      setClearOpen(false);
      void qc.invalidateQueries({ queryKey: ["danmaku-send-history"] });
    },
  });

  const clearVideoHistoryMutation = useMutation({
    mutationFn: videoHistoryClear,
    onSuccess: () => {
      qc.setQueriesData<VideoHistoryItem[]>({ queryKey: VIDEO_HISTORY_QUERY_KEY }, []);
      setClearOpen(false);
      void qc.invalidateQueries({ queryKey: VIDEO_HISTORY_QUERY_KEY });
    },
  });
  const resetWatchHistoryClear = clearWatchHistoryMutation.reset;
  const resetVideoHistoryClear = clearVideoHistoryMutation.reset;
  const resetDanmakuHistoryClear = clearDanmakuSendHistoryMutation.reset;

  const removeWatchHistoryMutation = useMutation({
    mutationFn: ({ siteId, roomId }: { siteId: HistoryItem["site_id"]; roomId: string }) =>
      invokeCmd<void>("history_remove", { siteId, roomId }),
    onSuccess: (_result, { siteId, roomId }) => {
      qc.setQueriesData<HistoryItem[]>({ queryKey: ["history"] }, (items) =>
        items?.filter((item) => item.site_id !== siteId || item.room_id !== roomId),
      );
      void qc.invalidateQueries({ queryKey: ["history"] });
      notify.success("已删除观看记录");
    },
    onError: () => {
      notify.error("删除观看记录失败", "请稍后重试。");
    },
  });

  const removeVideoHistoryMutation = useMutation({
    mutationFn: ({ kind, oid }: { kind: VideoHistoryKind; oid: string }) =>
      videoHistoryRemove(kind, oid),
    onSuccess: (_result, { kind, oid }) => {
      qc.setQueriesData<VideoHistoryItem[]>({ queryKey: VIDEO_HISTORY_QUERY_KEY }, (items) =>
        items?.filter((item) => item.kind !== kind || item.oid !== oid),
      );
      void qc.invalidateQueries({ queryKey: VIDEO_HISTORY_QUERY_KEY });
      notify.success("已删除观看记录");
    },
    onError: () => {
      notify.error("删除观看记录失败", "请稍后重试。");
    },
  });

  const watchGroups = useMemo(
    () =>
      groupHistoryByDate(
        filterHistoryBySite(
          filterHistoryItems(watchHistoryQuery.data ?? [], {
            keyword,
            dateFilter,
            getTimestamp: (item) => item.watched_at,
            getSearchFields: (item) => [item.title, item.user_name, item.room_id],
          }),
          platformFilter,
          disabledSiteIds,
        ),
        (item) => item.watched_at,
      ),
    [dateFilter, disabledSiteIds, keyword, platformFilter, watchHistoryQuery.data],
  );
  const videoGroups = useMemo(
    () =>
      groupHistoryByDate(
        filterHistoryItems(videoHistoryQuery.data ?? [], {
          keyword,
          dateFilter,
          getTimestamp: (item) => item.watched_at,
          getSearchFields: (item) => [item.title, item.author, item.part_title, item.bvid],
        }),
        (item) => item.watched_at,
      ),
    [dateFilter, keyword, videoHistoryQuery.data],
  );
  const danmakuGroups = useMemo(
    () =>
      groupHistoryByDate(
        filterHistoryBySite(
          filterHistoryItems(danmakuSendHistoryQuery.data ?? [], {
            keyword,
            dateFilter,
            getTimestamp: (item) => item.sent_at,
            getSearchFields: (item) => [
              item.content,
              item.room_title,
              item.room_user_name,
              item.room_id,
            ],
          }),
          platformFilter,
          disabledSiteIds,
        ),
        (item) => item.sent_at,
      ),
    [danmakuSendHistoryQuery.data, dateFilter, disabledSiteIds, keyword, platformFilter],
  );

  // 三条时间线各有自己的查询与清空变更；按视图查表，避免每处状态都写一遍三元。
  const clearableCount: Record<HistoryView, number> = {
    watch: allWatchHistoryQuery.data?.length ?? 0,
    video: videoHistoryQuery.data?.length ?? 0,
    danmaku: danmakuSendHistoryQuery.data?.length ?? 0,
  };
  const clearMutation: Record<
    HistoryView,
    { mutate: () => void; isPending: boolean; isError: boolean }
  > = {
    watch: clearWatchHistoryMutation,
    video: clearVideoHistoryMutation,
    danmaku: clearDanmakuSendHistoryMutation,
  };
  const activeHistoryQuery: Record<
    HistoryView,
    { refetch: () => Promise<unknown>; isRefetching: boolean; isLoading: boolean }
  > = {
    watch: watchHistoryQuery,
    video: videoHistoryQuery,
    danmaku: danmakuSendHistoryQuery,
  };
  const canClear = clearableCount[activeView] > 0;
  const clearPending = clearMutation[activeView].isPending;
  const clearError = clearMutation[activeView].isError;

  const handleViewChange = useCallback(
    (value: string) => {
      if (!HISTORY_VIEWS.includes(value as HistoryView)) return;
      setClearOpen(false);
      setSearchParams((current) => withHistoryView(current, value as HistoryView), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  const handleSearchChange = useCallback(
    (next: HistoryDateFilter) => {
      setSearchParams((current) => withHistorySearch(current, next), { replace: true });
    },
    [setSearchParams],
  );

  const handleDateFilterChange = useCallback(
    (next: string) => {
      setSearchParams((current) => withHistoryDateFilter(current, next), { replace: true });
    },
    [setSearchParams],
  );

  const handlePlatformFilterChange = useCallback(
    (next: HistoryPlatformFilter) => {
      setSearchParams((current) => withHistoryPlatformFilter(current, next), { replace: true });
    },
    [setSearchParams],
  );

  const resetFilters = useCallback(() => {
    setSearchParams(
      (current) =>
        withHistoryPlatformFilter(
          withHistoryDateFilter(withHistorySearch(current, ""), "all"),
          "all",
        ),
      { replace: true },
    );
  }, [setSearchParams]);

  const resetActiveClearMutation = useCallback(() => {
    const reset: Record<HistoryView, () => void> = {
      watch: resetWatchHistoryClear,
      video: resetVideoHistoryClear,
      danmaku: resetDanmakuHistoryClear,
    };
    reset[activeView]();
  }, [activeView, resetDanmakuHistoryClear, resetVideoHistoryClear, resetWatchHistoryClear]);

  const clearActiveHistory = () => clearMutation[activeView].mutate();

  // 头部拥有视图页签和清空按钮，因此发布它们渲染所需的状态，
  // 并监听它们请求的清空动作。确认对话框留在这里，
  // 与其背后的变更逻辑放在一起。
  const requestClear = useCallback(() => {
    resetActiveClearMutation();
    setClearOpen(true);
  }, [resetActiveClearMutation]);
  const headerState = useMemo(
    () => ({
      view: activeView,
      canClear,
      clearPending,
      onViewChange: handleViewChange,
      onRequestClear: requestClear,
    }),
    [activeView, canClear, clearPending, handleViewChange, requestClear],
  );
  useHistoryHeaderState(headerState);

  const historyTabSwipe = useHorizontalSwipe({
    items: HISTORY_VIEWS,
    value: activeView,
    onChange: (view: HistoryView) => handleViewChange(view),
    enabled: isMobileClient(),
    // 三个面板共用一条 track，下一页已经在屏上并跟随手指移动，
    // 而不是释放后才出现。
    layout: "track",
  });

  const refreshActiveHistory = () => activeHistoryQuery[activeView].refetch();
  const historyRefreshing = activeHistoryQuery[activeView].isRefetching;

  return (
    <PullToRefresh
      data-horizontal-swipe-surface
      onRefresh={refreshActiveHistory}
      refreshing={historyRefreshing}
      className="mx-auto h-full min-h-full w-full max-w-3xl"
      onPointerDownCapture={historyTabSwipe.onPointerDownCapture}
      onPointerMoveCapture={historyTabSwipe.onPointerMoveCapture}
      onPointerUpCapture={historyTabSwipe.onPointerUpCapture}
      onPointerCancelCapture={historyTabSwipe.onPointerCancelCapture}
      onClickCapture={historyTabSwipe.onClickCapture}
    >
      <RefreshFab
        onRefresh={refreshActiveHistory}
        pending={historyRefreshing || activeHistoryQuery[activeView].isLoading}
        label="刷新历史记录"
      />
      <div className="flex min-h-full flex-col touch-pan-y">
        <Tabs value={activeView} onValueChange={handleViewChange} className="min-h-full gap-4">
          <div className="flex items-center gap-2">
            <HistorySearchInput
              keyword={keyword}
              onChange={handleSearchChange}
              className="min-w-0 flex-1"
            />
            {/* 视频历史只有 B 站一个来源，平台筛选在该视图无从可选。 */}
            {activeView !== "video" && (
              <HistoryPlatformFilterControl
                value={platformFilter}
                sites={visibleSiteIds}
                onValueChange={handlePlatformFilterChange}
              />
            )}
            <HistoryDateFilterControl value={dateFilter} onValueChange={handleDateFilterChange} />
          </div>

          <div
            data-slot="horizontal-swipe-viewport"
            // 只裁剪横向轴：列表在 Shell 的滚动容器内向下生长，
            // 两个方向都裁剪会截断长历史。
            //
            // 每个面板为自己的卡片留出一像素的外扩描边，
            // 并把该绘制裁剪到自己的页面内。这样切换页签后
            // 相邻面板第一张卡的边缘不会透出来。
            className="min-w-0 overflow-x-clip"
          >
            <div
              ref={historyTabSwipe.bindPage}
              data-slot="horizontal-swipe-track"
              className="flex items-start"
              style={{ width: `${HISTORY_VIEWS.length * 100}%` }}
            >
              <TabsContent
                value="watch"
                keepMounted
                // track 让三个面板并排存在，离场页与进场页在手指之下一起移动。Base UI 会
                // 隐藏保持挂载的面板，导致整行塌陷 —— 可见性归 track 管，
                // 所以在这里撤销隐藏，并把非活动页标记为 inert。
                hidden={false}
                inert={activeView === "watch" ? undefined : true}
                className="mt-0 min-w-0 shrink-0 overflow-x-clip px-px"
                style={{ width: `${100 / HISTORY_VIEWS.length}%` }}
              >
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
                  watchGroups.length === 0 &&
                  (hasFilters ? (
                    <HistoryFilteredEmpty onReset={resetFilters} />
                  ) : (
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
                  ))}

                {watchGroups.length > 0 && (
                  <HistoryTimeline
                    groups={watchGroups}
                    headingIdPrefix="watch-history-date"
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

              <TabsContent
                value="video"
                keepMounted
                hidden={false}
                inert={activeView === "video" ? undefined : true}
                className="mt-0 min-w-0 shrink-0 overflow-x-clip px-px"
                style={{ width: `${100 / HISTORY_VIEWS.length}%` }}
              >
                {videoHistoryQuery.isLoading && <HistorySkeleton />}

                {videoHistoryQuery.isError && (
                  <ErrorState
                    error={videoHistoryQuery.error}
                    title="视频历史加载失败"
                    onRetry={() => void videoHistoryQuery.refetch()}
                  />
                )}

                {!videoHistoryQuery.isLoading &&
                  !videoHistoryQuery.isError &&
                  videoGroups.length === 0 &&
                  (hasFilters ? (
                    <HistoryFilteredEmpty onReset={resetFilters} />
                  ) : (
                    <Empty className="min-h-64 py-12">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <MonitorPlay aria-hidden />
                        </EmptyMedia>
                        <EmptyTitle>暂无视频观看记录</EmptyTitle>
                        <EmptyDescription>播放视频后会自动记录在这里。</EmptyDescription>
                      </EmptyHeader>
                      <EmptyContent>
                        <Button variant="outline" size="sm" onClick={() => navigate("/video")}>
                          <MonitorPlay data-icon="inline-start" aria-hidden />
                          去看视频
                        </Button>
                      </EmptyContent>
                    </Empty>
                  ))}

                {videoGroups.length > 0 && (
                  <HistoryTimeline
                    groups={videoGroups}
                    headingIdPrefix="video-history-date"
                    itemKey={(item) => `${item.kind}:${item.oid}:${item.watched_at}`}
                    renderItem={(item) => (
                      <VideoHistoryCard
                        item={item}
                        onOpen={() => navigate(videoHistoryPlayPath(item))}
                        onRemove={() =>
                          removeVideoHistoryMutation.mutate({ kind: item.kind, oid: item.oid })
                        }
                        isRemoving={removeVideoHistoryMutation.isPending}
                      />
                    )}
                  />
                )}
              </TabsContent>

              <TabsContent
                value="danmaku"
                keepMounted
                hidden={false}
                inert={activeView === "danmaku" ? undefined : true}
                className="mt-0 min-w-0 shrink-0 overflow-x-clip px-px"
                style={{ width: `${100 / HISTORY_VIEWS.length}%` }}
              >
                {danmakuSendHistoryQuery.isLoading && <DanmakuSendHistorySkeleton />}

                {danmakuSendHistoryQuery.isError && (
                  <ErrorState
                    error={danmakuSendHistoryQuery.error}
                    title="弹幕历史加载失败"
                    onRetry={() => void danmakuSendHistoryQuery.refetch()}
                  />
                )}

                {!danmakuSendHistoryQuery.isLoading &&
                  !danmakuSendHistoryQuery.isError &&
                  danmakuGroups.length === 0 &&
                  (hasFilters ? (
                    <HistoryFilteredEmpty onReset={resetFilters} />
                  ) : (
                    <Empty className="min-h-64 py-12">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <MessageSquareText aria-hidden />
                        </EmptyMedia>
                        <EmptyTitle>暂无弹幕历史</EmptyTitle>
                        <EmptyDescription>成功发送的弹幕会保存在此设备上。</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ))}

                {danmakuGroups.length > 0 && (
                  <HistoryTimeline
                    groups={danmakuGroups}
                    headingIdPrefix="danmaku-history-date"
                    itemKey={(item) => `${item.site_id}:${item.sent_at}:${item.content}`}
                    renderItem={(item) => (
                      <DanmakuSendHistoryCard
                        item={item}
                        onOpenRoom={
                          item.room_id
                            ? () =>
                                navigate(
                                  `/room/${item.site_id}/${encodeURIComponent(item.room_id ?? "")}`,
                                )
                            : undefined
                        }
                      />
                    )}
                  />
                )}
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </div>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={(nextOpen) => {
          if (clearPending) return;
          if (nextOpen) resetActiveClearMutation();
          setClearOpen(nextOpen);
        }}
        icon={<Trash2 aria-hidden />}
        title={CLEAR_CONFIRM_COPY[activeView].title}
        description={CLEAR_CONFIRM_COPY[activeView].description}
        error={clearError ? "清空失败，请重试。" : null}
        busy={clearPending}
        busyText="清空中…"
        actionIcon={<Trash2 data-icon="inline-start" aria-hidden />}
        confirmText="清空"
        onConfirm={clearActiveHistory}
      />
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
          <Skeleton className="aspect-video w-24 rounded-xl max-sm:w-20" />
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
              <Skeleton className="h-4 w-24 rounded-full" />
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
