import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  ExternalLink,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { preloadRouteModule } from "@/app/routeModules";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Separator } from "@/components/ui/separator";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { formatByteSize, normalizeVideoCoverUrl, cn } from "@/lib/utils";
import { isMobileClient } from "@/shared/clientPlatform";
import { CARD_SURFACE_CLASS, CARD_SURFACE_HOVER_CLASS } from "@/shared/components/cardSurface";
import { useLongPressDrawer } from "@/shared/hooks/useLongPressDrawer";
import {
  VIDEO_DOWNLOADS_QUERY_KEY,
  VIDEO_DOWNLOAD_VIEW_PARAM,
  VIDEO_DOWNLOAD_VIEWS,
  useVideoDownloads,
  upsertVideoDownloadInCache,
  videoDownloadCanReveal,
  videoDownloadDelete,
  videoDownloadIsActive,
  videoDownloadOpen,
  videoDownloadOpenDirectory,
  videoDownloadPause,
  videoDownloadPercent,
  videoDownloadPrimaryAction,
  videoDownloadResume,
  videoDownloadStatusLabel,
  videoDownloadSupported,
  videoDownloadViewFromSearch,
  withVideoDownloadView,
  type VideoDownloadItem,
  type VideoDownloadView,
} from "./videoDownload";
import { videoDownloadPlaybackEntryState, videoDownloadPlaybackPath } from "./videoDownloadRoute";

const DOWNLOAD_VIEW_LABELS: Record<VideoDownloadView, string> = {
  all: "全部",
  active: "未完成",
  completed: "已完成",
};

const DOWNLOAD_VIEW_ICONS = {
  all: Download,
  active: Clock3,
  completed: CheckCircle2,
} as const;

function DownloadViewSwitcher({
  value,
  counts,
  onValueChange,
  variant = "toolbar",
}: {
  value: VideoDownloadView;
  counts: Record<VideoDownloadView, number>;
  onValueChange: (view: VideoDownloadView) => void;
  variant?: "sidebar" | "toolbar";
}) {
  const sidebar = variant === "sidebar";
  return (
    <div
      className={cn(
        sidebar ? "flex flex-col gap-1" : "flex h-full items-stretch gap-1 max-md:w-full",
      )}
      role="tablist"
      aria-label="下载范围"
    >
      {VIDEO_DOWNLOAD_VIEWS.map((view) => {
        const active = view === value;
        const Icon = DOWNLOAD_VIEW_ICONS[view];
        return (
          <button
            key={view}
            type="button"
            role="tab"
            data-motion-control
            aria-selected={active}
            onClick={() => onValueChange(view)}
            className={cn(
              "relative flex items-center gap-2 text-sm font-medium transition-colors duration-150",
              sidebar ? "h-9 w-full rounded-lg px-2" : "h-full flex-1 justify-center px-2",
              active
                ? sidebar
                  ? "bg-secondary text-foreground"
                  : "text-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span>{DOWNLOAD_VIEW_LABELS[view]}</span>
            {counts[view] > 0 && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {counts[view]}
              </span>
            )}
            {!sidebar && active && (
              <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function downloadErrorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

/**
 * 关注页的视频下载子视图。
 *
 * 队列与文件都在 Rust 侧，这里只读连接状态。左栏沿用录制库的范围与操作位置，
 * 右侧列表按未完成 / 已完成分组。
 */
export function VideoDownloadPage({ active = true }: { active?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const supported = videoDownloadSupported();
  const queryClient = useQueryClient();
  const downloads = useVideoDownloads(active && supported);
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
  const activeItems = items.filter((item) => videoDownloadIsActive(item.status));
  const completedItems = items.filter((item) => !videoDownloadIsActive(item.status));
  const view = videoDownloadViewFromSearch(searchParams.get(VIDEO_DOWNLOAD_VIEW_PARAM));
  const viewCounts: Record<VideoDownloadView, number> = {
    all: items.length,
    active: activeItems.length,
    completed: completedItems.length,
  };
  const scopedActive = view === "completed" ? [] : activeItems;
  const scopedCompleted = view === "active" ? [] : completedItems;
  const scopedCount = scopedActive.length + scopedCompleted.length;

  const canReveal = videoDownloadCanReveal();
  const openFolder = () => {
    void videoDownloadOpenDirectory().catch((error: unknown) =>
      notify.error("无法打开下载目录", downloadErrorText(error)),
    );
  };
  const selectView = (nextView: VideoDownloadView) => {
    setSearchParams((current) => withVideoDownloadView(current, nextView), { replace: true });
  };
  const playDownload = (item: VideoDownloadItem) => {
    const path = videoDownloadPlaybackPath(item.id);
    preloadRouteModule(path);
    navigate(path, {
      state: videoDownloadPlaybackEntryState(`${location.pathname}${location.search}`),
    });
  };

  return (
    <div className="grid min-w-0 items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
      <nav
        aria-label="下载筛选"
        className="sticky top-3 hidden min-w-0 flex-col gap-1 border-r border-border pr-3 md:flex"
      >
        <div className="mb-1 flex items-center justify-between gap-2 px-2">
          <span className="text-sm font-medium text-muted-foreground">状态</span>
          <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
        </div>
        <DownloadViewSwitcher
          value={view}
          counts={viewCounts}
          variant="sidebar"
          onValueChange={selectView}
        />
        {canReveal && (
          <>
            <Separator className="my-1" />
            <Button variant="ghost" className="w-full justify-start" onClick={openFolder}>
              <FolderOpen data-icon="inline-start" aria-hidden />
              打开下载目录
            </Button>
          </>
        )}
      </nav>

      <section className="flex min-w-0 flex-col gap-3" aria-label="下载任务">
        <div className="h-10 md:hidden">
          <DownloadViewSwitcher
            value={view}
            counts={viewCounts}
            onValueChange={selectView}
            variant="toolbar"
          />
        </div>
        {canReveal && (
          <Button variant="secondary" className="self-start md:hidden" onClick={openFolder}>
            <FolderOpen data-icon="inline-start" aria-hidden />
            打开下载目录
          </Button>
        )}

        {downloads.isLoading && <DownloadSkeleton />}

        {downloads.isError && (
          <Empty className="min-h-56 border py-10">
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

        {!downloads.isLoading && !downloads.isError && scopedCount === 0 && (
          <Empty className="min-h-64 border py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Download aria-hidden />
              </EmptyMedia>
              <EmptyTitle>
                {view === "active"
                  ? "当前没有未完成的下载"
                  : view === "completed"
                    ? "还没有已完成的下载"
                    : "还没有下载任务"}
              </EmptyTitle>
              <EmptyDescription>
                {view === "completed"
                  ? "下载完成后的文件会出现在这里，可直接播放或定位文件。"
                  : "在视频播放页打开「更多操作」，选择「下载」并挑一个画质即可加入队列。"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {scopedActive.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="未完成的下载">
            <h2 className="text-sm font-semibold text-foreground">下载任务</h2>
            <div className="flex flex-col gap-2">
              {scopedActive.map((item) => (
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

        {scopedCompleted.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="已完成的下载">
            <h2 className="text-sm font-semibold text-foreground">已完成</h2>
            <div className="flex flex-col gap-2">
              {scopedCompleted.map((item) => (
                <DownloadRow
                  key={item.id}
                  item={item}
                  onDelete={() => setDeleteTarget(item)}
                  onPlay={() => playDownload(item)}
                  onOpenSystem={() =>
                    void videoDownloadOpen(item.id).catch((error: unknown) =>
                      notify.error("无法使用系统播放器打开", downloadErrorText(error)),
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
      </section>

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
  onOpenSystem,
  onReveal,
}: {
  item: VideoDownloadItem;
  pausing?: boolean;
  resuming?: boolean;
  onPause?: () => void;
  onResume?: () => void;
  onDelete: () => void;
  onPlay?: () => void;
  onOpenSystem?: () => void;
  onReveal?: () => void;
}) {
  const cover = normalizeVideoCoverUrl(item.cover);
  const percent = videoDownloadPercent(item);
  const inFlight = item.status === "downloading" || item.status === "merging";
  const primaryAction = videoDownloadPrimaryAction(item.status);
  const playable = primaryAction === "play";
  const mobile = isMobileClient();
  const cardDrawer = useLongPressDrawer({ enabled: mobile });
  const playbackPath = playable ? videoDownloadPlaybackPath(item.id) : null;
  const playerOrigin = `download:${item.id}`;
  const busy = Boolean(pausing || resuming);

  function openDownload() {
    if (cardDrawer.consumeSyntheticClick()) return;
    if (playable) onPlay?.();
  }

  function runFromDrawer(action: () => void) {
    cardDrawer.setOpen(false);
    action();
  }

  const primaryActions = (
    <>
      {primaryAction === "pause" && (
        <RowButton
          icon={<Pause data-icon="inline-start" aria-hidden />}
          label="暂停"
          busy={pausing}
          onClick={onPause}
        />
      )}
      {primaryAction === "resume" && (
        <RowButton
          icon={<Play data-icon="inline-start" aria-hidden />}
          label="继续"
          busy={resuming}
          onClick={onResume}
        />
      )}
      {primaryAction === "retry" && (
        <RowButton
          icon={<RotateCcw data-icon="inline-start" aria-hidden />}
          label="重试"
          busy={resuming}
          onClick={onResume}
        />
      )}
      {playable && (
        <>
          <RowButton
            icon={<ExternalLink data-icon="inline-start" aria-hidden />}
            label="系统播放器"
            onClick={onOpenSystem}
          />
          {onReveal ? (
            <RowButton
              icon={<FolderOpen data-icon="inline-start" aria-hidden />}
              label="文件夹"
              onClick={onReveal}
            />
          ) : null}
        </>
      )}
      <RowButton
        icon={<Trash2 data-icon="inline-start" aria-hidden />}
        label="删除"
        onClick={onDelete}
        destructive
      />
    </>
  );

  const cardClassName = cn(
    "relative flex gap-3 rounded-xl p-3 transition-[background-color,box-shadow,opacity]",
    CARD_SURFACE_CLASS,
    CARD_SURFACE_HOVER_CLASS,
    playable && cn("motion-card", "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"),
  );
  const cardBody = (
    <>
      {playable && (
        <button
          type="button"
          data-motion-press
          data-player-origin={playerOrigin}
          data-page-scroll-anchor={playerOrigin}
          className="absolute inset-0 z-0 rounded-xl outline-none"
          aria-label={`播放下载：${item.title}`}
          onPointerEnter={() => {
            if (playbackPath) preloadRouteModule(playbackPath);
          }}
          onPointerDown={() => {
            if (playbackPath) preloadRouteModule(playbackPath);
          }}
          onFocus={() => {
            if (playbackPath) preloadRouteModule(playbackPath);
          }}
          onClick={openDownload}
        />
      )}

      <div className="pointer-events-none relative z-10 aspect-video w-24 shrink-0 self-start overflow-hidden rounded-lg bg-muted sm:w-40">
        {cover ? (
          <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Download className="size-5" aria-hidden />
          </div>
        )}
      </div>
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-sm font-medium" title={item.title}>
            {item.title}
          </h3>
          <Badge
            variant={item.status === "failed" ? "destructive" : inFlight ? "default" : "secondary"}
          >
            {videoDownloadStatusLabel(item.status)}
          </Badge>
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

        <div
          className="pointer-events-auto flex flex-wrap items-center gap-1"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {primaryActions}
        </div>
      </div>
    </>
  );

  if (mobile) {
    return (
      <>
        <article
          data-download-id={item.id}
          className={cardClassName}
          onPointerDown={cardDrawer.onPointerDown}
          onPointerMove={cardDrawer.onPointerMove}
          onPointerUp={cardDrawer.onPointerUp}
          onPointerCancel={cardDrawer.onPointerCancel}
          onContextMenu={cardDrawer.onContextMenu}
        >
          {cardBody}
        </article>
        <Drawer open={cardDrawer.open} onOpenChange={cardDrawer.setOpen}>
          <DrawerContent>
            <DrawerTitle className="truncate">{item.title}</DrawerTitle>
            <div className="mt-2 flex flex-col gap-1">
              {playable && onPlay && (
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start max-md:h-10"
                  onClick={() => runFromDrawer(onPlay)}
                >
                  <Play data-icon="inline-start" aria-hidden />
                  应用内播放
                </Button>
              )}
              {primaryAction === "pause" && onPause && (
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start max-md:h-10"
                  disabled={busy}
                  onClick={() => runFromDrawer(onPause)}
                >
                  {pausing ? (
                    <Spinner data-icon="inline-start" aria-hidden />
                  ) : (
                    <Pause data-icon="inline-start" aria-hidden />
                  )}
                  暂停下载
                </Button>
              )}
              {(primaryAction === "resume" || primaryAction === "retry") && onResume && (
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start max-md:h-10"
                  disabled={busy}
                  onClick={() => runFromDrawer(onResume)}
                >
                  {resuming ? (
                    <Spinner data-icon="inline-start" aria-hidden />
                  ) : (
                    <RotateCcw data-icon="inline-start" aria-hidden />
                  )}
                  {primaryAction === "retry" ? "重试下载" : "继续下载"}
                </Button>
              )}
              {playable && onOpenSystem && (
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start max-md:h-10"
                  onClick={() => runFromDrawer(onOpenSystem)}
                >
                  <ExternalLink data-icon="inline-start" aria-hidden />
                  使用系统播放器
                </Button>
              )}
              {playable && onReveal && (
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start max-md:h-10"
                  onClick={() => runFromDrawer(onReveal)}
                >
                  <FolderOpen data-icon="inline-start" aria-hidden />
                  打开文件位置
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                className="justify-start text-destructive hover:bg-destructive/10 hover:text-destructive max-md:h-10"
                onClick={() => runFromDrawer(onDelete)}
              >
                <Trash2 data-icon="inline-start" aria-hidden />
                删除下载
              </Button>
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<article data-download-id={item.id} className={cardClassName} />}>
        {cardBody}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuGroup>
          <ContextMenuLabel>{item.title}</ContextMenuLabel>
          {playable && onPlay && (
            <ContextMenuItem onClick={onPlay}>
              <Play aria-hidden />
              应用内播放
            </ContextMenuItem>
          )}
          {primaryAction === "pause" && onPause && (
            <ContextMenuItem disabled={busy} onClick={onPause}>
              <Pause aria-hidden />
              暂停下载
            </ContextMenuItem>
          )}
          {(primaryAction === "resume" || primaryAction === "retry") && onResume && (
            <ContextMenuItem disabled={busy} onClick={onResume}>
              <RotateCcw aria-hidden />
              {primaryAction === "retry" ? "重试下载" : "继续下载"}
            </ContextMenuItem>
          )}
          {playable && onOpenSystem && (
            <ContextMenuItem onClick={onOpenSystem}>
              <ExternalLink aria-hidden />
              使用系统播放器
            </ContextMenuItem>
          )}
          {playable && onReveal && (
            <ContextMenuItem onClick={onReveal}>
              <FolderOpen aria-hidden />
              打开文件位置
            </ContextMenuItem>
          )}
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 aria-hidden />
            删除下载
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
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
        <div key={index} className={cn("flex gap-3 rounded-xl p-3", CARD_SURFACE_CLASS)}>
          <Skeleton className="aspect-video w-24 shrink-0 self-start rounded-lg sm:w-40" />
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
