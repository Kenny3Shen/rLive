import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ChevronRight,
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
  Users,
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
import type { SiteId } from "@/shared/types/live";
import {
  deleteRecording,
  formatRecordingDate,
  formatRecordingDuration,
  formatRecordingSize,
  RECORDINGS_QUERY_KEY,
  RECORDING_PLAYBACK_QUERY_KEY,
  RECORDING_STORAGE_QUERY_KEY,
  recordingErrorMessage,
  recordingStorageInfo,
  recordingSupported,
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
  onOpen,
  onStop,
  onReveal,
  onDelete,
}: {
  item: RecordingItem;
  revealing: boolean;
  stopping: boolean;
  onOpen?: () => void;
  onStop: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const playable = item.status !== "recording" && Boolean(onOpen);
  const playbackPath = `/recordings/play/${encodeURIComponent(item.id)}`;

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
    const current = groups.get(label);
    if (current) {
      current.items.push(item);
      current.latestAt = Math.max(current.latestAt, item.started_at);
      continue;
    }
    groups.set(label, {
      key: label,
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

function RecordingUserAvatar({ item }: { item: RecordingItem }) {
  const cover = normalizeImageUrl(item.cover);
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground ring-1 ring-border-subtle">
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
        <UserRound className="size-4" aria-hidden />
      )}
    </span>
  );
}

function RecordingUserList({
  groups,
  selectedKey,
  onSelect,
}: {
  groups: readonly RecordingUserGroup[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4 text-primary" aria-hidden />
          用户
        </CardTitle>
        <CardDescription>{groups.length} 位用户的本地录播</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {groups.map((group) => {
          const firstItem = group.items[0]!;
          const activeCount = group.items.filter((item) => item.status === "recording").length;
          return (
            <Button
              key={group.key}
              type="button"
              variant={selectedKey === group.key ? "secondary" : "ghost"}
              className={cn(
                "h-auto min-w-0 justify-start gap-2.5 rounded-lg px-2 py-2 text-left",
                selectedKey === group.key && "ring-1 ring-primary/25",
              )}
              aria-pressed={selectedKey === group.key}
              onClick={() => onSelect(group.key)}
            >
              <RecordingUserAvatar item={firstItem} />
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                <span className="w-full truncate font-medium">{group.label}</span>
                <span className="flex w-full items-center gap-1.5 text-xs font-normal text-muted-foreground">
                  <span>{group.items.length} 段录播</span>
                  {activeCount > 0 && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="text-destructive">{activeCount} 路录制中</span>
                    </>
                  )}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function RecordingsSkeleton() {
  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>
            <Skeleton className="h-5 w-16" />
          </CardTitle>
          <CardDescription>
            <Skeleton className="h-4 w-28" />
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 rounded-lg px-2 py-2">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="overflow-hidden py-0">
            <Skeleton className="aspect-video w-full rounded-none" />
            <CardContent className="flex flex-col gap-2 p-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </CardContent>
          </Card>
        ))}
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
  const storage = useQuery({
    queryKey: RECORDING_STORAGE_QUERY_KEY,
    enabled: supported,
    queryFn: recordingStorageInfo,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [deleteTarget, setDeleteTarget] = useState<RecordingItem | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);

  const items = useMemo(() => recordings.data ?? [], [recordings.data]);
  const activeItems = items.filter((item) => item.status === "recording");
  const userGroups = useMemo(() => recordingUserGroups(items), [items]);
  const requestedUser = searchParams.get("user");
  const selectedGroup =
    userGroups.find((group) => group.key === requestedUser) ?? userGroups[0] ?? null;
  const totalSize = items.reduce((total, item) => total + item.size_bytes, 0);

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

  const storageMutation = useMutation({
    mutationFn: setRecordingStoragePath,
    onSuccess: (info) => {
      queryClient.setQueryData(RECORDING_STORAGE_QUERY_KEY, info);
      void queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
      notify.success(info.is_default ? "已恢复默认录制目录" : "录制保存位置已更新");
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
    <div className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CircleDot
                className={activeItems.length > 0 ? "text-destructive" : undefined}
                aria-hidden
              />
              {activeItems.length > 0 ? `${activeItems.length} 路录制中` : "当前无录制任务"}
            </span>
            <span aria-hidden>·</span>
            <span>{formatRecordingSize(totalSize)} 本地内容</span>
          </div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">录制库</h1>
          <p className="text-sm text-muted-foreground">
            默认离页前确认；选择继续后任务在后台运行，结束后可随时本地回放。
          </p>
        </div>
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
          {userGroups.length > 0 ? (
            <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
              <RecordingUserList
                groups={userGroups}
                selectedKey={selectedGroup?.key ?? null}
                onSelect={(key) => {
                  setSearchParams(
                    (current) => {
                      current.set("user", key);
                      return current;
                    },
                    { replace: true },
                  );
                }}
              />

              <section
                className="flex min-w-0 flex-col gap-3"
                aria-labelledby="user-recordings-title"
              >
                <div className="flex min-w-0 flex-wrap items-end justify-between gap-2">
                  <div className="min-w-0">
                    <h2
                      id="user-recordings-title"
                      className="truncate font-heading text-base font-medium"
                    >
                      {selectedGroup?.label}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {selectedGroup?.items.length ?? 0} 段录播
                    </p>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">
                    点击 Card 进入播放页
                  </span>
                </div>
                <ul className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
                  {selectedGroup?.items.map((item) => (
                    <RecordingCard
                      key={item.id}
                      item={item}
                      stopping={stopMutation.isPending && stopMutation.variables === item.id}
                      onOpen={
                        item.status === "recording"
                          ? undefined
                          : () =>
                              navigate(
                                `/recordings/play/${encodeURIComponent(item.id)}?user=${encodeURIComponent(recordingUserLabel(item))}`,
                              )
                      }
                      onStop={() => stopMutation.mutate(item.id)}
                      revealing={
                        revealMutation.isPending && revealMutation.variables === item.file_path
                      }
                      onReveal={() => revealMutation.mutate(item.file_path)}
                      onDelete={() => setDeleteTarget(item)}
                    />
                  ))}
                </ul>
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
            <DialogDescription>新录制写入当前目录，已有录制仍保留在原位置。</DialogDescription>
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
