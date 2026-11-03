import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Captions,
  CircleDot,
  Eye,
  FolderOpen,
  HardDrive,
  MessageSquareText,
  Videotape,
  Radio,
  Square,
  Trash2,
  Tv,
  UserRound,
} from "lucide-react";
import { preloadRouteModule } from "@/app/routeModules";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import { cn, normalizeImageUrl } from "@/lib/utils";
import {
  LocalMediaCard,
  LocalMediaArtwork,
  LocalMediaCardAction,
  LocalMediaCardProgress,
  LocalMediaCardStat,
  LocalMediaCardSkeleton,
} from "@/shared/components/LocalMediaCard";
import { ErrorState } from "@/shared/components/ErrorState";
import {
  PlatformFilterSelect,
  type PlatformFilter,
} from "@/shared/components/PlatformFilterSelect";
import { Separator } from "@/components/ui/separator";
import { LIVE_SITE_IDS } from "@/shared/siteId";
import { RecordingViewSwitcher } from "./RecordingHeaderControls";
import {
  RECORDING_LIBRARY_RETURN_SOURCE,
  RECORDING_VIEW_PARAM,
  recordingLibraryReturnPath,
  recordingPlaybackPath,
  recordingViewFromSearch,
  withRecordingView,
  type RecordingLibraryReturnState,
  type RecordingView,
} from "./recordingRoute";
import { isWatchFinished, isWatchProgressWorthKeeping } from "@/shared/watchProgress";
import {
  activeRecordingCount,
  deleteRecording,
  exportRecordingDanmakuAss,
  formatRecordingDate,
  formatRecordingDuration,
  formatRecordingSize,
  RECORDINGS_QUERY_KEY,
  RECORDING_PLAYBACK_QUERY_KEY,
  RECORDING_WATCH_PROGRESS_QUERY_KEY,
  RECORDING_WATCH_PROGRESS_RESUME_KEY,
  recordingErrorMessage,
  recordingPlatformFromSearch,
  recordingSourceLabel,
  recordingStatusLabel,
  recordingSupported,
  recordingUserGroupKey,
  recordingWatchProgressList,
  recordingsForPlatform,
  recordingsForView,
  stopRecording,
  useRecordings,
  type RecordingItem,
  type RecordingStatus,
  type RecordingWatchProgress,
} from "./recording";

function recordingUserLabel(item: RecordingItem): string {
  return item.user_name.trim() || recordingSourceLabel(item);
}

function recordingUserAvatar(item: RecordingItem): string {
  return item.user_avatar?.trim() || item.cover;
}

function RecordingStatusBadge({ status }: { status: RecordingStatus }) {
  if (status === "recording") {
    return (
      <Badge variant="destructive">
        <CircleDot data-icon="inline-start" aria-hidden />
        录制中
      </Badge>
    );
  }

  return (
    <Badge variant={status === "failed" ? "destructive" : "secondary"}>
      {recordingStatusLabel(status)}
    </Badge>
  );
}

/**
 * 录制进行中时进度事件每路约 500ms 更新一次列表（未变条目保持引用），memo 让只有
 * 正在录的那张卡重渲染。回调统一接收条目本身，调用方可传稳定引用。
 */
const RecordingCard = memo(function RecordingCard({
  item,
  watched,
  revealing,
  stopping,
  exportingAss,
  onOpen,
  onStop,
  onExportAss,
  onReveal,
  onDelete,
}: {
  item: RecordingItem;
  watched: RecordingWatchProgress | null;
  revealing: boolean;
  stopping: boolean;
  exportingAss: boolean;
  onOpen: (item: RecordingItem) => void;
  onStop: (id: string) => void;
  onExportAss: (id: string) => void;
  onReveal: (filePath: string) => void;
  onDelete: (item: RecordingItem) => void;
}) {
  const playable = item.status !== "recording";
  const playbackPath = recordingPlaybackPath(item.id);
  // 伴生文件只有任务完成写入后才存在。
  const exportable = item.status !== "recording" && item.include_danmaku && item.danmaku_count > 0;
  // 上次看到哪儿。过一遍最小进度门槛：误触留下的一两秒不该在卡片上显示，
  // 也不该画出一条几乎看不见的进度条。
  const watchedSeconds =
    watched && isWatchProgressWorthKeeping(watched.progress) ? watched.progress : 0;
  const recordedSeconds = Math.max(0, item.duration_ms / 1000);
  const watchedPercent =
    recordedSeconds > 0 ? Math.min(100, (watchedSeconds / recordedSeconds) * 100) : 0;
  const watchedLabel = isWatchFinished(watchedSeconds, recordedSeconds)
    ? "已看完"
    : `已看到 ${formatRecordingDuration(watchedSeconds * 1_000)}`;

  const playerOrigin = `recording:${item.id}`;
  return (
    <li className="min-w-0" data-recording-id={item.id}>
      <LocalMediaCard
        kind="recording"
        title={item.title}
        subtitle={`${recordingSourceLabel(item)} · ${formatRecordingDate(item.started_at)}`}
        status={<RecordingStatusBadge status={item.status} />}
        artwork={
          <LocalMediaArtwork
            sources={[normalizeImageUrl(item.cover), normalizeImageUrl(item.user_avatar)]}
            icon={item.source_kind === "iptv" ? Tv : Radio}
          />
        }
        duration={formatRecordingDuration(item.duration_ms)}
        playbackTrigger={
          playable ? (
            <button
              type="button"
              data-motion-press
              data-player-origin={playerOrigin}
              data-page-scroll-anchor={playerOrigin}
              className="absolute inset-0 z-0 rounded-xl outline-none"
              aria-label={`打开录播：${item.title}`}
              onPointerEnter={() => preloadRouteModule(playbackPath)}
              onPointerDown={() => preloadRouteModule(playbackPath)}
              onFocus={() => preloadRouteModule(playbackPath)}
              onClick={() => onOpen(item)}
            />
          ) : undefined
        }
        metadata={
          <>
            <LocalMediaCardStat icon={HardDrive} label="文件大小">
              {formatRecordingSize(item.size_bytes)}
            </LocalMediaCardStat>
            {item.include_danmaku && (
              <LocalMediaCardStat icon={MessageSquareText} label="已录制弹幕">
                {item.danmaku_count} 条弹幕
              </LocalMediaCardStat>
            )}
            {watchedSeconds > 0 && (
              <LocalMediaCardStat
                icon={Eye}
                label={`已看到 ${formatRecordingDuration(watchedSeconds * 1_000)} / ${formatRecordingDuration(item.duration_ms)}`}
              >
                {watchedLabel}
              </LocalMediaCardStat>
            )}
          </>
        }
        progress={
          watchedPercent > 0 ? (
            <LocalMediaCardProgress value={watchedPercent} label={`${item.title} 观看进度`} />
          ) : undefined
        }
        actions={
          <>
            {!playable && (
              <LocalMediaCardAction
                label={stopping ? "正在保存" : "停止并保存"}
                icon={Square}
                variant="destructive"
                busy={stopping}
                onClick={() => onStop(item.id)}
              />
            )}
            {exportable && (
              <LocalMediaCardAction
                label="导出 ASS 弹幕字幕"
                icon={Captions}
                busy={exportingAss}
                onClick={() => onExportAss(item.id)}
              />
            )}
            <LocalMediaCardAction
              label="打开文件位置"
              icon={FolderOpen}
              busy={revealing}
              onClick={() => onReveal(item.file_path)}
            />
            <LocalMediaCardAction
              label="删除录制"
              icon={Trash2}
              variant="destructive"
              onClick={() => onDelete(item)}
            />
          </>
        }
      />
    </li>
  );
});

type RecordingUserGroup = {
  key: string;
  label: string;
  items: RecordingItem[];
  latestAt: number;
};

function recordingUserGroups(items: readonly RecordingItem[]): RecordingUserGroup[] {
  const groups = new Map<string, RecordingUserGroup>();
  for (const item of items) {
    const label = recordingUserLabel(item);
    const key = recordingUserGroupKey(item);
    const current = groups.get(key);
    if (current) {
      current.items.push(item);
      current.latestAt = Math.max(current.latestAt, item.started_at);
      continue;
    }
    groups.set(key, {
      key,
      label,
      items: [item],
      latestAt: item.started_at,
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.latestAt - left.latestAt || left.label.localeCompare(right.label, "zh-CN"),
  );
}

function RecordingUserAvatar({
  item,
  compact = false,
}: {
  item: RecordingItem;
  compact?: boolean;
}) {
  const cover = normalizeImageUrl(recordingUserAvatar(item));
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground ring-1 ring-border-subtle",
        compact ? "size-6" : "size-7",
      )}
    >
      <UserRound className={compact ? "size-3.5" : "size-4"} aria-hidden />
      {cover && (
        <img
          src={cover}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}

function RecordingUserTarget({
  group,
  selected,
  surface,
  onSelect,
}: {
  group: RecordingUserGroup;
  selected: boolean;
  surface: "desktop" | "mobile";
  onSelect: () => void;
}) {
  const activeCount = group.items.filter((item) => item.status === "recording").length;

  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      size={surface === "desktop" ? "default" : "sm"}
      className={cn("justify-start gap-2", surface === "desktop" ? "w-full px-2" : "shrink-0")}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
    >
      <RecordingUserAvatar item={group.items[0]!} compact={surface === "mobile"} />
      <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
      {activeCount > 0 && (
        <CircleDot
          className="size-3 shrink-0 text-destructive"
          aria-label={`${activeCount} 路录制中`}
        />
      )}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {group.items.length}
      </span>
    </Button>
  );
}

function RecordingUserList({
  groups,
  selectedKey,
  view,
  viewCounts,
  platformFilter,
  onSelect,
  onViewChange,
  onPlatformChange,
}: {
  groups: readonly RecordingUserGroup[];
  selectedKey: string | null;
  view: RecordingView;
  viewCounts: Record<RecordingView, number>;
  platformFilter: PlatformFilter;
  onSelect: (key: string) => void;
  onViewChange: (view: RecordingView) => void;
  onPlatformChange: (value: PlatformFilter) => void;
}) {
  return (
    <nav
      aria-label="录制筛选"
      className="sticky top-3 hidden max-h-[calc(100dvh-7rem)] min-w-0 flex-col gap-1 border-r border-border pr-3 md:flex"
    >
      <PlatformFilterSelect
        value={platformFilter}
        sites={LIVE_SITE_IDS}
        compact={false}
        onValueChange={onPlatformChange}
      />
      <Separator className="my-1" />
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <span className="text-sm font-medium text-muted-foreground">范围</span>
      </div>
      <RecordingViewSwitcher
        value={view}
        counts={viewCounts}
        variant="sidebar"
        onValueChange={onViewChange}
      />
      <Separator className="my-1" />
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <span className="text-sm font-medium text-muted-foreground">用户</span>
        <span className="text-xs tabular-nums text-muted-foreground">{groups.length}</span>
      </div>
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto py-0.5">
        {groups.map((group) => (
          <RecordingUserTarget
            key={group.key}
            group={group}
            selected={selectedKey === group.key}
            surface="desktop"
            onSelect={() => onSelect(group.key)}
          />
        ))}
      </div>
    </nav>
  );
}

function RecordingEmptyState({
  view,
  hasScopedItems,
}: {
  view: RecordingView;
  hasScopedItems: boolean;
}) {
  if (hasScopedItems) {
    return (
      <Empty className="min-h-56 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Videotape aria-hidden />
          </EmptyMedia>
          <EmptyTitle>当前平台暂无录播</EmptyTitle>
          <EmptyDescription>请选择其他平台或查看全部平台。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Empty className="min-h-64 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Videotape aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          {view === "recording"
            ? "当前没有录制中的任务"
            : view === "recorded"
              ? "还没有已保存的录制"
              : "还没有本地录制"}
        </EmptyTitle>
        <EmptyDescription>
          {view === "recording"
            ? "进入直播间或 IPTV 播放页，点击顶部标题栏右侧的录制按钮即可开始。开始后任务会持续在后台录制。"
            : view === "recorded"
              ? "停止录制后的任务会保存到这里，可直接回放、导出弹幕字幕或定位文件。"
              : "进入直播间或 IPTV 播放页，点击顶部标题栏右侧的录制按钮即可开始。"}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function RecordingsSkeleton() {
  return (
    <div className="grid min-w-0 items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
      <div className="hidden min-w-0 flex-col gap-2 border-r border-border pr-3 md:flex">
        <Skeleton className="h-8 w-full rounded-lg" />
        <Separator />
        <Skeleton className="mx-2 h-3 w-12" />
        <div className="flex flex-col gap-1">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex h-9 items-center gap-2 rounded-lg px-2">
              <Skeleton className="size-7 rounded-lg" />
              <Skeleton className="h-3.5 flex-1" />
              <Skeleton className="h-3 w-4" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <Skeleton className="h-10 w-full rounded-lg md:hidden" />
        <Skeleton className="h-11 w-full rounded-lg md:hidden" />
        <div className="-mx-1 flex gap-1 overflow-hidden px-1 pb-1 md:hidden">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton
              key={index}
              className="h-7 w-24 shrink-0 rounded-lg [@media(pointer:coarse)]:h-11"
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <LocalMediaCardSkeleton key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function RecordingsPage({ active = true }: { active?: boolean }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const recordings = useRecordings(active);
  const supported = recordingSupported();
  const [deleteTarget, setDeleteTarget] = useState<RecordingItem | null>(null);

  /**
   * 全部录制的观看进度。单独一条查询而不是塞进 `recording_list`：录制列表在采集
   * 期间每 15 秒轮询并被事件刷新，观看进度只在回放时变，两者的失效时机不同。
   */
  const watchProgress = useQuery({
    queryKey: RECORDING_WATCH_PROGRESS_QUERY_KEY,
    enabled: supported && active,
    queryFn: recordingWatchProgressList,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  const watchProgressById = useMemo(
    () => new Map((watchProgress.data ?? []).map((entry) => [entry.id, entry])),
    [watchProgress.data],
  );

  const items = useMemo(() => recordings.data ?? [], [recordings.data]);
  const requestedPlatform = searchParams.get("platform");
  const platformFilter: PlatformFilter = recordingPlatformFromSearch(requestedPlatform);
  const view = recordingViewFromSearch(searchParams.get(RECORDING_VIEW_PARAM));
  // 头部页签统计的是整个库而不是活动平台，
  // 因此切到某个作用域绝不会看到标注着它列不出的行数的页签。
  const activeCount = activeRecordingCount(items);
  const viewCounts = useMemo(
    () => ({
      all: items.length,
      recording: activeCount,
      recorded: items.length - activeCount,
    }),
    [activeCount, items.length],
  );
  const scopedItems = useMemo(() => recordingsForView(items, view), [items, view]);
  const filteredItems = useMemo(
    () => recordingsForPlatform(scopedItems, platformFilter),
    [platformFilter, scopedItems],
  );
  const userGroups = useMemo(() => recordingUserGroups(filteredItems), [filteredItems]);
  const requestedUser = searchParams.get("user");
  const selectedGroup =
    userGroups.find((group) => group.key === requestedUser) ?? userGroups[0] ?? null;

  const selectView = useCallback(
    (nextView: RecordingView) => {
      setSearchParams(
        (current) => {
          const next = withRecordingView(current, nextView);
          // 所选用户很少同时存在于两个作用域中，因此让新作用域自己选第一个分组，
          // 而不是静默回退。
          next.delete("user");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const stopMutation = useMutation({
    mutationFn: stopRecording,
    onSuccess: (item) => {
      queryClient.setQueryData<RecordingItem[]>(RECORDINGS_QUERY_KEY, (current) =>
        (current ?? []).map((entry) => (entry.id === item.id ? item : entry)),
      );
      void queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
      notify.success("录制已保存", item.title);
    },
    onError: (error) => notify.error("停止录制失败", recordingErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteRecording,
    onSuccess: (_, id) => {
      queryClient.setQueryData<RecordingItem[]>(RECORDINGS_QUERY_KEY, (current) =>
        (current ?? []).filter((item) => item.id !== id),
      );
      queryClient.removeQueries({ queryKey: [RECORDING_PLAYBACK_QUERY_KEY, id] });
      // 后端删除录像时顺带删掉了进度行，缓存跟着走：留着只会让卡片画一条
      // 属于已删文件的进度。
      queryClient.setQueryData<RecordingWatchProgress[]>(
        RECORDING_WATCH_PROGRESS_QUERY_KEY,
        (current) => (current ?? []).filter((entry) => entry.id !== id),
      );
      queryClient.removeQueries({ queryKey: [RECORDING_WATCH_PROGRESS_RESUME_KEY, id] });
      setDeleteTarget(null);
      notify.success("录制已删除");
    },
    onError: (error) => notify.error("删除录制失败", recordingErrorMessage(error)),
  });

  const revealMutation = useMutation({
    mutationFn: (path: string) => revealItemInDir(path),
    onError: (error) => notify.error("无法打开文件位置", recordingErrorMessage(error)),
  });

  const exportAssMutation = useMutation({
    mutationFn: exportRecordingDanmakuAss,
    onSuccess: (path) => notify.success(`弹幕字幕已导出：${path}`),
    onError: (error) => notify.error("导出弹幕字幕失败", recordingErrorMessage(error)),
  });

  function selectUser(key: string) {
    setSearchParams(
      (current) => {
        current.set("user", key);
        return current;
      },
      { replace: true },
    );
  }

  function selectPlatform(value: PlatformFilter) {
    setSearchParams(
      (current) => {
        if (value === "all") current.delete("platform");
        else current.set("platform", value);
        current.delete("user");
        return current;
      },
      { replace: true },
    );
  }

  const openRecording = useCallback(
    (item: RecordingItem) => {
      const params = new URLSearchParams({ user: recordingUserGroupKey(item) });
      if (platformFilter !== "all") params.set("platform", platformFilter);
      if (view !== "all") params.set(RECORDING_VIEW_PARAM, view);
      const state: RecordingLibraryReturnState = {
        rliveNavigationSource: RECORDING_LIBRARY_RETURN_SOURCE,
        returnTo: recordingLibraryReturnPath(searchParams),
      };
      navigate(`${recordingPlaybackPath(item.id)}?${params.toString()}`, { state });
    },
    [navigate, platformFilter, searchParams, view],
  );

  if (!supported) {
    return (
      <Empty className="min-h-[60vh] border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Videotape aria-hidden />
          </EmptyMedia>
          <EmptyTitle>录制功能仅支持桌面端</EmptyTitle>
          <EmptyDescription>请在 Windows、macOS 或 Linux 桌面版中录制和回放直播。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1600px] flex-col gap-4">
      {recordings.isPending ? (
        <RecordingsSkeleton />
      ) : recordings.isError ? (
        <ErrorState
          error={recordings.error}
          title="无法读取录制库"
          onRetry={() => void recordings.refetch()}
        />
      ) : (
        <div className="grid min-w-0 items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
          <RecordingUserList
            groups={userGroups}
            selectedKey={selectedGroup?.key ?? null}
            view={view}
            viewCounts={viewCounts}
            platformFilter={platformFilter}
            onSelect={selectUser}
            onViewChange={selectView}
            onPlatformChange={selectPlatform}
          />

          <section className="flex min-w-0 flex-col gap-3" aria-label="录播列表">
            <RecordingViewSwitcher
              value={view}
              counts={viewCounts}
              onValueChange={selectView}
              className="h-10 w-full md:hidden"
            />
            <PlatformFilterSelect
              value={platformFilter}
              sites={LIVE_SITE_IDS}
              compact={false}
              className="md:hidden"
              onValueChange={selectPlatform}
            />
            <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1 md:hidden">
              {userGroups.map((group) => (
                <RecordingUserTarget
                  key={group.key}
                  group={group}
                  selected={selectedGroup?.key === group.key}
                  surface="mobile"
                  onSelect={() => selectUser(group.key)}
                />
              ))}
            </div>
            {selectedGroup ? (
              <ul className="flex min-w-0 flex-col gap-3">
                {selectedGroup.items.map((item) => (
                  <RecordingCard
                    key={item.id}
                    item={item}
                    watched={watchProgressById.get(item.id) ?? null}
                    stopping={stopMutation.isPending && stopMutation.variables === item.id}
                    onOpen={openRecording}
                    onStop={stopMutation.mutate}
                    exportingAss={
                      exportAssMutation.isPending && exportAssMutation.variables === item.id
                    }
                    onExportAss={exportAssMutation.mutate}
                    revealing={
                      revealMutation.isPending && revealMutation.variables === item.file_path
                    }
                    onReveal={revealMutation.mutate}
                    onDelete={setDeleteTarget}
                  />
                ))}
              </ul>
            ) : (
              <RecordingEmptyState view={view} hasScopedItems={scopedItems.length > 0} />
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleteTarget(null);
        }}
        icon={<Trash2 aria-hidden />}
        title="删除这段录制？"
        description={<>将永久删除“{deleteTarget?.title}”及其本地媒体文件，此操作无法恢复。</>}
        busy={deleteMutation.isPending}
        busyText="正在删除…"
        actionIcon={<Trash2 data-icon="inline-start" aria-hidden />}
        confirmText="删除"
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}
