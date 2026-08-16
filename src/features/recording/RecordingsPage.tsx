import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
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
  CardFooter,
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
import { cn, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import { ErrorState } from "@/shared/components/ErrorState";
import type { SiteId } from "@/shared/types/live";
import { RecordingPlayer } from "./RecordingPlayer";
import {
  deleteRecording,
  formatRecordingDate,
  formatRecordingDuration,
  formatRecordingSize,
  RECORDINGS_QUERY_KEY,
  recordingErrorMessage,
  recordingPlaybackUrl,
  recordingProtocolLabel,
  recordingStorageInfo,
  recordingSupported,
  setRecordingStoragePath,
  stopRecording,
  useRecordings,
  type RecordingItem,
  type RecordingStatus,
} from "./recording";

const RECORDING_PLAYBACK_QUERY_KEY = "recording-playback";
const RECORDING_STORAGE_QUERY_KEY = ["recording-storage"] as const;

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

function RecordingArtwork({ item }: { item: RecordingItem }) {
  const cover = normalizeImageUrl(item.cover);
  const SourceIcon = item.source_kind === "iptv" ? Tv : Radio;

  return (
    <span className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-border-subtle max-2xl:w-24">
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
        <span className="flex size-full items-center justify-center text-muted-foreground">
          <SourceIcon aria-hidden />
        </span>
      )}
      <span className="absolute right-1 bottom-1 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] leading-none text-white backdrop-blur-sm">
        {formatRecordingDuration(item.duration_ms)}
      </span>
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

function ActiveRecordingCard({
  item,
  stopping,
  onStop,
}: {
  item: RecordingItem;
  stopping: boolean;
  onStop: () => void;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="min-w-0 truncate pr-2">{item.title}</CardTitle>
        <CardDescription className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{item.user_name || recordingSourceLabel(item)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{recordingProtocolLabel(item.protocol)}</span>
        </CardDescription>
        <CardAction>
          <RecordingStatusBadge status={item.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Clock3 aria-hidden />
          {formatRecordingDuration(item.duration_ms)}
        </span>
        <span className="flex items-center gap-1.5">
          <HardDrive aria-hidden />
          {formatRecordingSize(item.size_bytes)}
        </span>
        {item.include_danmaku && (
          <span className="flex items-center gap-1.5">
            <MessageSquareText aria-hidden />
            {item.danmaku_count} 条弹幕
          </span>
        )}
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="button" variant="destructive" size="sm" disabled={stopping} onClick={onStop}>
          {stopping ? (
            <Spinner data-icon="inline-start" aria-hidden />
          ) : (
            <Square data-icon="inline-start" aria-hidden />
          )}
          {stopping ? "正在保存…" : "停止并保存"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function RecordingListItem({
  item,
  selected,
  revealing,
  onSelect,
  onReveal,
  onDelete,
}: {
  item: RecordingItem;
  selected: boolean;
  revealing: boolean;
  onSelect: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="min-w-0">
      <Card
        size="sm"
        className={cn("min-w-0 gap-0 py-1.5", selected && "bg-muted/50 ring-2 ring-primary/40")}
      >
        <CardContent className="flex min-w-0 items-center gap-1.5 px-1.5">
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-w-0 flex-1 justify-start gap-2 overflow-hidden rounded-lg p-1.5 text-left whitespace-normal"
            aria-pressed={selected}
            onClick={onSelect}
          >
            <RecordingArtwork item={item} />
            <span className="flex min-w-0 flex-1 flex-col items-start gap-1.5 overflow-hidden">
              <span className="w-full truncate font-medium text-foreground">{item.title}</span>
              <span className="flex w-full min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
                <span className="truncate">{item.user_name || recordingSourceLabel(item)}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{formatRecordingSize(item.size_bytes)}</span>
              </span>
              <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-muted-foreground">
                <span>{formatRecordingDate(item.started_at)}</span>
                {item.include_danmaku && (
                  <span className="flex items-center gap-1">
                    <MessageSquareText data-icon="inline-start" aria-hidden />
                    {item.danmaku_count}
                  </span>
                )}
                <RecordingStatusBadge status={item.status} />
              </span>
            </span>
          </Button>
          <div className="flex shrink-0 flex-col gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={revealing}
              aria-label="在文件管理器中显示"
              title="在文件管理器中显示"
              onClick={onReveal}
            >
              {revealing ? <Spinner aria-hidden /> : <FolderOpen aria-hidden />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label="删除录制"
              title="删除录制"
              onClick={onDelete}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

function RecordingsSkeleton() {
  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>
            <Skeleton className="h-5 w-24" />
          </CardTitle>
          <CardDescription>
            <Skeleton className="h-4 w-36" />
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 p-2">
              <Skeleton className="aspect-video w-24 rounded-lg" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <Skeleton className="h-5 w-2/5" />
          </CardTitle>
          <CardDescription>
            <Skeleton className="h-4 w-1/3" />
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="aspect-video w-full rounded-2xl" />
        </CardContent>
      </Card>
    </div>
  );
}

export function RecordingsPage() {
  const queryClient = useQueryClient();
  const recordings = useRecordings();
  const supported = recordingSupported();
  const storage = useQuery({
    queryKey: RECORDING_STORAGE_QUERY_KEY,
    enabled: supported,
    queryFn: recordingStorageInfo,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecordingItem | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);

  const items = recordings.data ?? [];
  const activeItems = items.filter((item) => item.status === "recording");
  const savedItems = items.filter((item) => item.status !== "recording");
  const selectedItem = savedItems.find((item) => item.id === selectedId) ?? savedItems[0] ?? null;
  const totalSize = items.reduce((total, item) => total + item.size_bytes, 0);

  const playback = useQuery({
    queryKey: [RECORDING_PLAYBACK_QUERY_KEY, selectedItem?.id],
    enabled: supported && Boolean(selectedItem),
    queryFn: async () => {
      const url = await recordingPlaybackUrl(selectedItem!.id);
      // playback_url may normalize a legacy FLV and persist its measured
      // duration. Refresh the list before rendering the player so the slider
      // uses that corrected metadata instead of the stale card snapshot.
      await queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
      return url;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const stopMutation = useMutation({
    mutationFn: stopRecording,
    onSuccess: (item) => {
      queryClient.setQueryData<RecordingItem[]>(RECORDINGS_QUERY_KEY, (current) =>
        (current ?? []).map((entry) => (entry.id === item.id ? item : entry)),
      );
      void queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
      setSelectedId(item.id);
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
      if (selectedId === id) setSelectedId(null);
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
          {activeItems.length > 0 && (
            <section className="flex flex-col gap-3" aria-labelledby="active-recordings-title">
              <div className="flex items-center gap-2">
                <h2 id="active-recordings-title" className="font-heading text-sm font-medium">
                  正在录制
                </h2>
                <Badge variant="destructive">{activeItems.length}</Badge>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {activeItems.map((item) => (
                  <ActiveRecordingCard
                    key={item.id}
                    item={item}
                    stopping={stopMutation.isPending && stopMutation.variables === item.id}
                    onStop={() => stopMutation.mutate(item.id)}
                  />
                ))}
              </div>
            </section>
          )}

          <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
            <section
              className="flex min-w-0 flex-col gap-3"
              aria-labelledby="saved-recordings-title"
            >
              <div>
                <h2 id="saved-recordings-title" className="font-heading text-base font-medium">
                  已保存
                </h2>
                <p className="text-sm text-muted-foreground">
                  {savedItems.length > 0
                    ? `${savedItems.length} 段本地录制`
                    : "等待第一段录制完成"}
                </p>
              </div>
              {savedItems.length > 0 ? (
                <ul className="flex min-w-0 flex-col gap-2">
                  {savedItems.map((item) => (
                    <RecordingListItem
                      key={item.id}
                      item={item}
                      selected={item.id === selectedItem?.id}
                      revealing={
                        revealMutation.isPending && revealMutation.variables === item.file_path
                      }
                      onSelect={() => setSelectedId(item.id)}
                      onReveal={() => revealMutation.mutate(item.file_path)}
                      onDelete={() => setDeleteTarget(item)}
                    />
                  ))}
                </ul>
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
            </section>

            {selectedItem ? (
              <Card className="min-w-0 xl:sticky xl:top-0">
                <CardHeader className="min-w-0">
                  <CardTitle className="min-w-0 truncate">{selectedItem.title}</CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{recordingSourceLabel(selectedItem)}</span>
                    {selectedItem.user_name && (
                      <span className="flex items-center gap-1">
                        <UserRound aria-hidden />
                        {selectedItem.user_name}
                      </span>
                    )}
                    <span>{formatRecordingDate(selectedItem.started_at)}</span>
                    <Badge variant="outline">{recordingProtocolLabel(selectedItem.protocol)}</Badge>
                    {selectedItem.include_danmaku && (
                      <Badge variant="outline">
                        <MessageSquareText data-icon="inline-start" aria-hidden />
                        {selectedItem.danmaku_count} 条弹幕
                      </Badge>
                    )}
                    <RecordingStatusBadge status={selectedItem.status} />
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {playback.isPending ? (
                    <Skeleton className="aspect-video w-full rounded-2xl" />
                  ) : playback.isError ? (
                    <ErrorState
                      error={playback.error}
                      title="无法打开这段录制"
                      onRetry={() => void playback.refetch()}
                    />
                  ) : playback.data ? (
                    <RecordingPlayer item={selectedItem} url={playback.data} />
                  ) : null}

                  <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <div className="flex flex-col gap-1">
                      <dt className="text-xs text-muted-foreground">时长</dt>
                      <dd className="font-mono">
                        {formatRecordingDuration(selectedItem.duration_ms)}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-xs text-muted-foreground">大小</dt>
                      <dd className="font-mono">{formatRecordingSize(selectedItem.size_bytes)}</dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-xs text-muted-foreground">来源</dt>
                      <dd>{recordingSourceLabel(selectedItem)}</dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-xs text-muted-foreground">状态</dt>
                      <dd>{recordingStatusLabel(selectedItem.status)}</dd>
                    </div>
                  </dl>

                  {selectedItem.error && (
                    <ErrorState
                      error={selectedItem.error}
                      title={selectedItem.status === "failed" ? "录制失败" : "录制过程中断"}
                    />
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card className="xl:sticky xl:top-0">
                <CardHeader>
                  <CardTitle>本地回放</CardTitle>
                  <CardDescription>录制结束后会显示在这里</CardDescription>
                </CardHeader>
                <CardContent>
                  <Empty className="min-h-80 border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Videotape aria-hidden />
                      </EmptyMedia>
                      <EmptyTitle>选择一段录制开始回放</EmptyTitle>
                      <EmptyDescription>录制内容保存在本机，不会上传到服务器。</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}

      <Dialog open={storageOpen} onOpenChange={setStorageOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>录制保存位置</DialogTitle>
            <DialogDescription>
              新录制写入当前目录，已有录制仍保留在原位置。
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5">
            <HardDrive className="shrink-0 text-muted-foreground" aria-hidden />
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs"
              title={storage.data?.path}
            >
              {storage.isPending
                ? "正在读取录制目录…"
                : storage.data?.path || "录制目录不可用"}
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
