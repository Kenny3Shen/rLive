import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Download, FolderOpen, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
import { Spinner } from "@/components/ui/spinner";
import { formatByteSize, normalizeVideoCoverUrl, cn } from "@/lib/utils";
import {
  VIDEO_DOWNLOADS_QUERY_KEY,
  useVideoDownloads,
  upsertVideoDownloadInCache,
  videoDownloadCanReveal,
  videoDownloadDelete,
  videoDownloadIsActive,
  videoDownloadOpen,
  videoDownloadOpenDirectory,
  videoDownloadPause,
  videoDownloadPercent,
  videoDownloadResume,
  videoDownloadStatusLabel,
  videoDownloadSupported,
  type VideoDownloadItem,
  type VideoDownloadStatus,
} from "./videoDownload";

const STATUS_BADGE_CLASS: Record<VideoDownloadStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  downloading: "bg-primary/12 text-primary",
  paused: "bg-muted text-muted-foreground",
  merging: "bg-primary/12 text-primary",
  failed: "bg-destructive/12 text-destructive",
  completed: "bg-success/12 text-success",
};

function downloadErrorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

/**
 * 视频下载任务页（`/video?tab=download`）。
 *
 * 这里只读连接状态：队列与文件都在 Rust 侧，页面靠事件与低频轮询同步。
 * 下载入口在播放页的 `⋮` 溢出菜单与桌面端底部栏。
 */
export function VideoDownloadPage() {
  const supported = videoDownloadSupported();
  const queryClient = useQueryClient();
  const downloads = useVideoDownloads(supported);
  const [deleteTarget, setDeleteTarget] = useState<VideoDownloadItem | null>(null);

  const pauseMutation = useMutation({
    mutationFn: videoDownloadPause,
    onSuccess: (item) => upsertVideoDownloadInCache(queryClient, item),
    onError: (error) => notify.error("暂停下载失败", downloadErrorText(error)),
  });
  const resumeMutation = useMutation({
    mutationFn: videoDownloadResume,
    onSuccess: (item) => upsertVideoDownloadInCache(queryClient, item),
    onError: (error) => notify.error("继续下载失败", downloadErrorText(error)),
  });
  const deleteMutation = useMutation({
    mutationFn: videoDownloadDelete,
    onSuccess: (_value, id) => {
      queryClient.setQueryData<VideoDownloadItem[]>(VIDEO_DOWNLOADS_QUERY_KEY, (items) =>
        items?.filter((item) => item.id !== id),
      );
      setDeleteTarget(null);
    },
    onError: (error) => notify.error("删除下载失败", downloadErrorText(error)),
  });

  if (!supported) {
    return (
      <Empty className="mx-auto min-h-72 max-w-lg py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Download aria-hidden />
          </EmptyMedia>
          <EmptyTitle>视频下载仅在 rLive 客户端中可用</EmptyTitle>
          <EmptyDescription>
            下载需要把视频轨与音频轨合并为
            MP4，依赖客户端的媒体合并能力。浏览器预览中请继续在线观看。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const items = downloads.data ?? [];
  const active = items.filter((item) => videoDownloadIsActive(item.status));
  const completed = items.filter((item) => !videoDownloadIsActive(item.status));

  const canReveal = videoDownloadCanReveal();
  const openFolder = () => {
    void videoDownloadOpenDirectory().catch((error: unknown) =>
      notify.error("无法打开下载目录", downloadErrorText(error)),
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">视频下载</h1>
        {canReveal && (
          <Button variant="secondary" onClick={openFolder}>
            <FolderOpen data-icon="inline-start" aria-hidden />
            打开下载目录
          </Button>
        )}
      </div>

      {downloads.isLoading && <DownloadSkeleton />}

      {downloads.isError && (
        <Empty className="min-h-56 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleAlert aria-hidden />
            </EmptyMedia>
            <EmptyTitle>下载列表加载失败</EmptyTitle>
            <EmptyDescription>{downloadErrorText(downloads.error)}</EmptyDescription>
          </EmptyHeader>
          <Button variant="secondary" onClick={() => void downloads.refetch()}>
            重试
          </Button>
        </Empty>
      )}

      {!downloads.isLoading && !downloads.isError && items.length === 0 && (
        <Empty className="min-h-64 py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Download aria-hidden />
            </EmptyMedia>
            <EmptyTitle>还没有下载任务</EmptyTitle>
            <EmptyDescription>
              在视频播放页打开「更多操作」，选择「下载」并挑一个画质即可加入队列。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {active.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="未完成的下载">
          <h2 className="text-sm font-semibold text-foreground">下载任务</h2>
          <div className="flex flex-col gap-2">
            {active.map((item) => (
              <DownloadRow
                key={item.id}
                item={item}
                pausing={pauseMutation.isPending && pauseMutation.variables === item.id}
                resuming={resumeMutation.isPending && resumeMutation.variables === item.id}
                onPause={() => pauseMutation.mutate(item.id)}
                onResume={() => resumeMutation.mutate(item.id)}
                onDelete={() => setDeleteTarget(item)}
              />
            ))}
          </div>
        </section>
      )}

      {completed.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="已完成的下载">
          <h2 className="text-sm font-semibold text-foreground">已完成</h2>
          <div className="flex flex-col gap-2">
            {completed.map((item) => (
              <DownloadRow
                key={item.id}
                item={item}
                onDelete={() => setDeleteTarget(item)}
                onPlay={() =>
                  void videoDownloadOpen(item.id).catch((error: unknown) =>
                    notify.error("无法打开下载文件", downloadErrorText(error)),
                  )
                }
                onReveal={
                  canReveal
                    ? () =>
                        void revealItemInDir(item.file_path).catch((error: unknown) =>
                          notify.error("无法打开文件位置", downloadErrorText(error)),
                        )
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        icon={<Trash2 aria-hidden />}
        title="删除这个下载？"
        description={
          deleteTarget
            ? `「${deleteTarget.title}」的本地文件与下载记录都会被删除。`
            : "本地文件与下载记录都会被删除。"
        }
        confirmText="删除"
        busy={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}

function DownloadRow({
  item,
  pausing,
  resuming,
  onPause,
  onResume,
  onDelete,
  onPlay,
  onReveal,
}: {
  item: VideoDownloadItem;
  pausing?: boolean;
  resuming?: boolean;
  onPause?: () => void;
  onResume?: () => void;
  onDelete: () => void;
  onPlay?: () => void;
  onReveal?: () => void;
}) {
  const cover = normalizeVideoCoverUrl(item.cover);
  const percent = videoDownloadPercent(item);
  const inFlight = item.status === "downloading" || item.status === "merging";

  return (
    <article className="flex gap-3 rounded-xl border border-border/70 bg-card p-3">
      <div className="aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-muted sm:w-40">
        {cover ? (
          <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Download className="size-5" aria-hidden />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-sm font-medium" title={item.title}>
            {item.title}
          </h3>
          <span
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium",
              STATUS_BADGE_CLASS[item.status],
            )}
          >
            {videoDownloadStatusLabel(item.status)}
          </span>
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {[item.quality_label || "等待取流", item.author].filter(Boolean).join(" · ")}
        </p>

        {item.status === "failed" && item.error ? (
          <p role="alert" className="text-sm text-destructive">
            {item.error}
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <div
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              aria-label={`${item.title} 下载进度`}
            >
              <div
                className={cn(
                  "h-full rounded-full bg-primary transition-[width] duration-300",
                  inFlight && percent >= 100 && "animate-pulse",
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
              {item.total_bytes > 0
                ? `${formatByteSize(item.downloaded_bytes)} / ${formatByteSize(item.total_bytes)}`
                : formatByteSize(item.downloaded_bytes)}
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1">
          {item.status === "downloading" || item.status === "queued" ? (
            <RowButton icon={<Pause aria-hidden />} label="暂停" busy={pausing} onClick={onPause} />
          ) : null}
          {item.status === "paused" ? (
            <RowButton
              icon={<Play aria-hidden />}
              label="继续"
              busy={resuming}
              onClick={onResume}
            />
          ) : null}
          {item.status === "failed" ? (
            <RowButton
              icon={<RotateCcw aria-hidden />}
              label="重试"
              busy={resuming}
              onClick={onResume}
            />
          ) : null}
          {item.status === "completed" ? (
            <>
              <RowButton icon={<Play aria-hidden />} label="播放" onClick={onPlay} />
              {onReveal ? (
                <RowButton icon={<FolderOpen aria-hidden />} label="文件夹" onClick={onReveal} />
              ) : null}
            </>
          ) : null}
          <RowButton icon={<Trash2 aria-hidden />} label="删除" onClick={onDelete} destructive />
        </div>
      </div>
    </article>
  );
}

function RowButton({
  icon,
  label,
  busy,
  destructive,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  busy?: boolean;
  destructive?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      className={cn(destructive && "text-destructive hover:text-destructive")}
      onClick={onClick}
    >
      {busy ? <Spinner data-icon="inline-start" aria-hidden /> : icon}
      {label}
    </Button>
  );
}

function DownloadSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex gap-3 rounded-xl border border-border/70 bg-card p-3">
          <Skeleton className="aspect-video w-32 shrink-0 rounded-lg sm:w-40" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-1.5 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
