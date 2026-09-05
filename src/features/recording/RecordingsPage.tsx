import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Captions,
  CircleDot,
  Clock3,
  Eye,
  FolderOpen,
  HardDrive,
  MessageSquareText,
  RotateCcw,
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
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import { ErrorState } from "@/shared/components/ErrorState";
import {
  PlatformFilterSelect,
  type PlatformFilter,
} from "@/shared/components/PlatformFilterSelect";
import { Separator } from "@/components/ui/separator";
import { LIVE_SITE_IDS } from "@/shared/siteId";
import type { SiteId } from "@/shared/types/live";
import { useRecordingHeaderState } from "./recordingHeaderState";
import {
  RECORDING_VIEW_PARAM,
  recordingPlaybackPath,
  recordingViewFromSearch,
  withRecordingView,
  type RecordingView,
} from "./recordingRoute";
import {
  isWatchFinished,
  isWatchProgressWorthKeeping,
} from "@/shared/watchProgress";
import {
  activeRecordingCount,
  deleteRecording,
  exportRecordingDanmakuAss,
  formatRecordingDate,
  formatRecordingDuration,
  formatRecordingSize,
  RECORDINGS_QUERY_KEY,
  RECORDING_PLAYBACK_QUERY_KEY,
  RECORDING_STORAGE_QUERY_KEY,
  RECORDING_WATCH_PROGRESS_QUERY_KEY,
  RECORDING_WATCH_PROGRESS_RESUME_KEY,
  recordingErrorMessage,
  recordingPlatformFromSearch,
  recordingStorageInfo,
  recordingSupported,
  recordingUserGroupKey,
  recordingWatchProgressList,
  recordingsForPlatform,
  recordingsForView,
  setRecordingStoragePath,
  stopRecording,
  useRecordings,
  type RecordingItem,
  type RecordingStatus,
  type RecordingWatchProgress,
} from "./recording";
function recordingStatusLabel(status: RecordingStatus): string {
  switch (status) {
    case "recording":
      return "录制中";
    case "interrupted":
      return "已中断";
    case "failed":
      return "失败";
    default:
      return "已保存";
  }
}

function recordingSourceLabel(item: RecordingItem): string {
  if (item.source_kind === "iptv") return "IPTV";
  if (item.site_id) return SITE_LABELS[item.site_id as SiteId] ?? item.site_id;
  return "直播";
}

function recordingUserLabel(item: RecordingItem): string {
  return item.user_name.trim() || recordingSourceLabel(item);
}

function recordingUserAvatar(item: RecordingItem): string {
  return item.user_avatar?.trim() || item.cover;
}

/**
 * 单场录制的缩略图：优先用捕获时的房间封面，其次主播头像，最后平台标识。
 *
 * 封面才是卡片应当展示的内容 —— 那是这一场直播的画面。但录制存储的是开播时
 * 的 URL，多个平台会为每次采集生成新的封面地址，旧地址可能不再可解析。
 * 这里不是放弃封面，而是只在真正加载失败时逐级降级：封面、头像、再到底层的
 * 图标。缺少这一步时 WebView 会画出破图占位符。
 */
function RecordingArtwork({ item }: { item: RecordingItem }) {
  const cover = normalizeImageUrl(item.cover);
  const avatar = normalizeImageUrl(item.user_avatar);
  // 不同的 key 使切换来源时重新挂载 img 并重试加载。
  const [failed, setFailed] = useState<string[]>([]);
  const artwork = [cover, avatar].find((candidate) => candidate && !failed.includes(candidate));
  const SourceIcon = item.source_kind === "iptv" ? Tv : Radio;

  return (
    <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground ring-1 ring-border-subtle">
      <SourceIcon className="size-4" aria-hidden />
      {artwork && (
        <img
          key={artwork}
          src={artwork}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed((current) => [...current, artwork])}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
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

function RecordingCard({
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
  onOpen?: () => void;
  onStop: () => void;
  onExportAss: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const playable = item.status !== "recording" && Boolean(onOpen);
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

  return (
    <li className="min-w-0">
      <Card
        size="sm"
        className="relative h-full gap-2 py-3 transition-[background-color,box-shadow,opacity] hover:bg-card-elevated hover:ring-foreground/20"
      >
        {playable && (
          <button
            type="button"
            data-motion-press
            className="absolute inset-0 z-0 rounded-xl outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring-color)]"
            aria-label={`打开录播：${item.title}`}
            onPointerEnter={() => preloadRouteModule(playbackPath)}
            onPointerDown={() => preloadRouteModule(playbackPath)}
            onFocus={() => preloadRouteModule(playbackPath)}
            onClick={onOpen}
          />
        )}

        <CardHeader className="pointer-events-none relative z-10 items-center gap-x-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <RecordingArtwork item={item} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <CardTitle className="truncate" title={item.title}>
                {item.title}
              </CardTitle>
              <CardDescription className="truncate" title={formatRecordingDate(item.started_at)}>
                {recordingSourceLabel(item)} · {formatRecordingDate(item.started_at)}
              </CardDescription>
            </div>
          </div>

          <CardAction className="pointer-events-auto relative z-10 flex items-center gap-0.5 self-center">
            {item.status === "recording" && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={stopping}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      aria-label="停止并保存"
                      onClick={onStop}
                    />
                  }
                >
                  {stopping ? <Spinner aria-hidden /> : <Square aria-hidden />}
                </TooltipTrigger>
                <TooltipContent>{stopping ? "正在保存" : "停止并保存"}</TooltipContent>
              </Tooltip>
            )}
            {exportable && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={exportingAss}
                      className="text-muted-foreground"
                      aria-label="导出 ASS 弹幕字幕"
                      onClick={onExportAss}
                    />
                  }
                >
                  {exportingAss ? <Spinner aria-hidden /> : <Captions aria-hidden />}
                </TooltipTrigger>
                <TooltipContent>
                  {exportingAss ? "正在导出字幕" : "导出 ASS 弹幕字幕"}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={revealing}
                    className="text-muted-foreground"
                    aria-label="在文件管理器中显示"
                    onClick={onReveal}
                  />
                }
              >
                {revealing ? <Spinner aria-hidden /> : <FolderOpen aria-hidden />}
              </TooltipTrigger>
              <TooltipContent>在文件管理器中显示</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label="删除录制"
                    onClick={onDelete}
                  />
                }
              >
                <Trash2 aria-hidden />
              </TooltipTrigger>
              <TooltipContent>删除录制</TooltipContent>
            </Tooltip>
          </CardAction>
        </CardHeader>

        <CardContent className="pointer-events-none relative z-10 flex min-h-5 min-w-0 flex-wrap items-center gap-1.5 overflow-hidden">
          <RecordingStatusBadge status={item.status} />
          <Badge variant="outline" title={`时长：${formatRecordingDuration(item.duration_ms)}`}>
            <Clock3 aria-hidden />
            {formatRecordingDuration(item.duration_ms)}
          </Badge>
          <Badge variant="outline" title={`大小：${formatRecordingSize(item.size_bytes)}`}>
            <HardDrive aria-hidden />
            {formatRecordingSize(item.size_bytes)}
          </Badge>
          {item.include_danmaku && (
            <Badge variant="outline" title={`${item.danmaku_count} 条弹幕`}>
              <MessageSquareText aria-hidden />
              {item.danmaku_count}
            </Badge>
          )}
          {watchedSeconds > 0 && (
            <Badge
              variant="outline"
              title={`已看到 ${formatRecordingDuration(watchedSeconds * 1_000)} / ${formatRecordingDuration(item.duration_ms)}`}
            >
              <Eye aria-hidden />
              {watchedLabel}
            </Badge>
          )}
        </CardContent>
        {watchedPercent > 0 && (
          /* 观看进度压在卡片底边：一眼看出上次停在哪儿，不占徽章行的宽度。
             留出左右内边距而不是铺满，避免与卡片圆角相切。 */
          <span className="pointer-events-none absolute inset-x-3 bottom-1.5 z-10 h-0.5 overflow-hidden rounded-full bg-foreground/10">
            <span className="block h-full bg-primary" style={{ width: `${watchedPercent}%` }} />
          </span>
        )}
      </Card>
    </li>
  );
}

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
  platformFilter,
  onSelect,
  onPlatformChange,
}: {
  groups: readonly RecordingUserGroup[];
  selectedKey: string | null;
  platformFilter: PlatformFilter;
  onSelect: (key: string) => void;
  onPlatformChange: (value: PlatformFilter) => void;
}) {
  return (
    <nav
      aria-label="录制用户"
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
        <span className="text-xs font-medium text-muted-foreground">用户</span>
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
        <Skeleton className="h-8 w-full rounded-lg md:hidden" />
        <div className="-mx-1 flex gap-1 overflow-hidden px-1 pb-1 md:hidden">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-24 shrink-0 rounded-lg" />
          ))}
        </div>
        <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
          {Array.from({ length: 6 }).map((_, index) => (
            <Card key={index} size="sm" className="gap-2">
              <CardHeader className="items-center gap-x-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Skeleton className="size-10 shrink-0 rounded-lg" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-3/5" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                </div>
                <CardAction className="self-center">
                  <Skeleton className="size-7 rounded-lg" />
                </CardAction>
              </CardHeader>
              <CardContent className="flex min-h-5 items-center gap-1.5">
                <Skeleton className="h-5 w-14 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RecordingsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const recordings = useRecordings();
  const supported = recordingSupported();
  const [deleteTarget, setDeleteTarget] = useState<RecordingItem | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const storage = useQuery({
    queryKey: RECORDING_STORAGE_QUERY_KEY,
    enabled: supported,
    queryFn: recordingStorageInfo,
    staleTime: 5_000,
    refetchInterval: storageOpen ? 5_000 : false,
    refetchOnWindowFocus: true,
  });

  /**
   * 全部录制的观看进度。单独一条查询而不是塞进 `recording_list`：录制列表在采集
   * 期间每 15 秒轮询并被事件刷新，观看进度只在回放时变，两者的失效时机不同。
   */
  const watchProgress = useQuery({
    queryKey: RECORDING_WATCH_PROGRESS_QUERY_KEY,
    enabled: supported,
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
  const openStorage = useCallback(() => setStorageOpen(true), []);
  useRecordingHeaderState(
    useMemo(
      () => ({
        view,
        counts: viewCounts,
        onViewChange: selectView,
        onRequestStorage: openStorage,
      }),
      [openStorage, selectView, view, viewCounts],
    ),
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

  const storageMutation = useMutation({
    mutationFn: setRecordingStoragePath,
    onSuccess: (info) => {
      queryClient.setQueryData(RECORDING_STORAGE_QUERY_KEY, info);
      void queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
      notify.success(info.is_default ? "已恢复默认录制目录" : "录制保存位置已更新，已有录制已迁移");
    },
    onError: (error) => notify.error("无法更新录制保存位置", recordingErrorMessage(error)),
  });

  async function chooseStorageDirectory() {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择录制保存位置",
        defaultPath: storage.data?.path,
      });
      if (typeof selected === "string") storageMutation.mutate(selected);
    } catch (error) {
      notify.error("无法选择录制目录", recordingErrorMessage(error));
    }
  }

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

  function openRecording(item: RecordingItem) {
    const params = new URLSearchParams({ user: recordingUserGroupKey(item) });
    if (platformFilter !== "all") params.set("platform", platformFilter);
    navigate(`${recordingPlaybackPath(item.id)}?${params.toString()}`);
  }

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
        <>
          {scopedItems.length > 0 ? (
            <div className="grid min-w-0 items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
              <RecordingUserList
                groups={userGroups}
                selectedKey={selectedGroup?.key ?? null}
                platformFilter={platformFilter}
                onSelect={selectUser}
                onPlatformChange={selectPlatform}
              />

              <section className="flex min-w-0 flex-col gap-3" aria-label="录播列表">
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
                  <ul className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
                    {selectedGroup.items.map((item) => (
                      <RecordingCard
                        key={item.id}
                        item={item}
                        watched={watchProgressById.get(item.id) ?? null}
                        stopping={stopMutation.isPending && stopMutation.variables === item.id}
                        onOpen={item.status === "recording" ? undefined : () => openRecording(item)}
                        onStop={() => stopMutation.mutate(item.id)}
                        exportingAss={
                          exportAssMutation.isPending && exportAssMutation.variables === item.id
                        }
                        onExportAss={() => exportAssMutation.mutate(item.id)}
                        revealing={
                          revealMutation.isPending && revealMutation.variables === item.file_path
                        }
                        onReveal={() => revealMutation.mutate(item.file_path)}
                        onDelete={() => setDeleteTarget(item)}
                      />
                    ))}
                  </ul>
                ) : (
                  <Empty className="min-h-56 border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Videotape aria-hidden />
                      </EmptyMedia>
                      <EmptyTitle>当前平台暂无录播</EmptyTitle>
                      <EmptyDescription>请选择其他平台或查看全部平台。</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </section>
            </div>
          ) : (
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
          )}
        </>
      )}

      <Dialog open={storageOpen} onOpenChange={setStorageOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>录制保存位置</DialogTitle>
            <DialogDescription>新录制和已有录制都使用当前目录。</DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5">
            <HardDrive className="shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={storage.data?.path}>
              {storage.isPending ? "正在读取录制目录…" : storage.data?.path || "录制目录不可用"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {storage.isPending
              ? "正在读取当前目录"
              : storage.isError
                ? "当前目录读取失败，可重新选择保存位置"
                : storage.data?.is_default
                  ? "正在使用应用默认目录"
                  : "正在使用自定义目录"}
          </p>
          {storage.data?.available_bytes != null && (
            <p
              role="status"
              aria-live="polite"
              className={cn(
                "text-xs",
                storage.data.available_bytes < storage.data.minimum_free_bytes
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              剩余空间：{formatRecordingSize(storage.data.available_bytes)}
              {storage.data.available_bytes < storage.data.minimum_free_bytes && "，不足以开始录制"}
            </p>
          )}
          <DialogFooter className="flex-wrap">
            {!storage.data?.is_default && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={storageMutation.isPending}
                onClick={() => storageMutation.mutate(null)}
              >
                <RotateCcw data-icon="inline-start" aria-hidden />
                恢复默认
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={revealMutation.isPending || !storage.data?.path}
              onClick={() => {
                if (storage.data?.path) revealMutation.mutate(storage.data.path);
              }}
            >
              {revealMutation.isPending && revealMutation.variables === storage.data?.path ? (
                <Spinner data-icon="inline-start" aria-hidden />
              ) : (
                <FolderOpen data-icon="inline-start" aria-hidden />
              )}
              显示目录
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={storage.isPending || storageMutation.isPending}
              onClick={() => void chooseStorageDirectory()}
            >
              <FolderOpen data-icon="inline-start" aria-hidden />
              更改位置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
