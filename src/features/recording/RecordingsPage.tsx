import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Captions,
  CircleDot,
  Clock3,
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  deleteRecording,
  exportRecordingDanmakuAss,
  formatRecordingDate,
  formatRecordingDuration,
  formatRecordingSize,
  RECORDINGS_QUERY_KEY,
  RECORDING_PLAYBACK_QUERY_KEY,
  RECORDING_STORAGE_QUERY_KEY,
  recordingErrorMessage,
  recordingPlatformFromSearch,
  recordingStorageInfo,
  recordingSupported,
  recordingUserGroupKey,
  recordingsForPlatform,
  setRecordingStoragePath,
  stopRecording,
  useRecordings,
  type RecordingItem,
  type RecordingStatus,
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

function RecordingArtwork({ item }: { item: RecordingItem }) {
  const cover = normalizeImageUrl(item.cover);
  const SourceIcon = item.source_kind === "iptv" ? Tv : Radio;

  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground ring-1 ring-border-subtle">
      {cover ? (
        <img
          src={cover}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
      ) : (
        <SourceIcon className="size-4" aria-hidden />
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
  const playbackPath = `/recordings/play/${encodeURIComponent(item.id)}`;
  // The sidecar only exists once the task finished writing it.
  const exportable = item.status !== "recording" && item.include_danmaku && item.danmaku_count > 0;

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
        </CardContent>
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
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground ring-1 ring-border-subtle",
        compact ? "size-6" : "size-7",
      )}
    >
      {cover ? (
        <img
          src={cover}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
      ) : (
        <UserRound className={compact ? "size-3.5" : "size-4"} aria-hidden />
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

  const items = useMemo(() => recordings.data ?? [], [recordings.data]);
  const requestedPlatform = searchParams.get("platform");
  const platformFilter: PlatformFilter = recordingPlatformFromSearch(requestedPlatform);
  const filteredItems = useMemo(
    () => recordingsForPlatform(items, platformFilter),
    [items, platformFilter],
  );
  const userGroups = useMemo(() => recordingUserGroups(filteredItems), [filteredItems]);
  const requestedUser = searchParams.get("user");
  const selectedGroup =
    userGroups.find((group) => group.key === requestedUser) ?? userGroups[0] ?? null;

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
    onSuccess: (path) =>
      notify.success(`弹幕字幕已导出：${path}`),
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
    navigate(`/recordings/play/${encodeURIComponent(item.id)}?${params.toString()}`);
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
      <header className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">录制库</h1>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setStorageOpen(true)}
        >
          <HardDrive data-icon="inline-start" aria-hidden />
          保存位置
        </Button>
      </header>

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
          {items.length > 0 ? (
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
                <EmptyTitle>还没有本地录制</EmptyTitle>
                <EmptyDescription>
                  进入直播间或 IPTV 播放页，点击顶部标题栏右侧的录制按钮即可开始。
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

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2 aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>删除这段录制？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除“{deleteTarget?.title}”及其本地媒体文件，此操作无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={!deleteTarget || deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              {deleteMutation.isPending ? (
                <Spinner data-icon="inline-start" aria-hidden />
              ) : (
                <Trash2 data-icon="inline-start" aria-hidden />
              )}
              {deleteMutation.isPending ? "正在删除…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
