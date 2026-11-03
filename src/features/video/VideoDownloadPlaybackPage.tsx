import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, CircleAlert, Download, ExternalLink, FolderOpen } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn, formatByteSize, normalizeVideoCoverUrl } from "@/lib/utils";
import { ErrorState } from "@/shared/components/ErrorState";
import { CARD_SURFACE_CLASS } from "@/shared/components/cardSurface";
import { formatVideoDuration } from "./videoHistory";
import { LocalDownloadPlayer } from "./LocalDownloadPlayer";
import {
  VIDEO_DOWNLOAD_PLAYBACK_QUERY_KEY,
  videoDownloadCanReveal,
  videoDownloadOpen,
  videoDownloadPlaybackInfo,
  videoDownloadSupported,
  type VideoDownloadItem,
} from "./videoDownload";
import {
  shouldPopToVideoDownloadList,
  videoDownloadPlaybackReturnTarget,
} from "./videoDownloadRoute";

function playbackErrorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

function PlaybackTopBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="relative flex h-11 shrink-0 items-center justify-center border-b border-border/80 bg-sidebar/90 px-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="motion-back-button absolute left-3 z-10 rounded-lg hover:bg-muted/70 max-md:size-11 max-md:touch-manipulation"
              aria-label="返回下载列表"
              onClick={onBack}
            >
              <ChevronLeft aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="bottom">返回下载列表</TooltipContent>
      </Tooltip>
      <p
        className="absolute inset-x-16 truncate text-center text-sm font-semibold tracking-tight"
        title={title}
      >
        {title}
      </p>
    </header>
  );
}

function PlaybackState({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background p-4 md:p-6">
      <div className="w-full max-w-xl">{children}</div>
    </main>
  );
}

function DownloadDetails({ item }: { item: VideoDownloadItem }) {
  const cover = normalizeVideoCoverUrl(item.cover);
  const revealAvailable = videoDownloadCanReveal();
  const openWithSystemPlayer = () => {
    void videoDownloadOpen(item.id).catch((error: unknown) =>
      notify.error("无法使用系统播放器打开", playbackErrorText(error)),
    );
  };
  const revealInFolder = () => {
    void revealItemInDir(item.file_path).catch((error: unknown) =>
      notify.error("无法打开文件位置", playbackErrorText(error)),
    );
  };

  return (
    <aside
      className="flex min-h-0 w-full flex-col gap-3 overflow-y-auto border-t border-border/80 bg-sidebar p-3 md:w-[300px] md:flex-none md:border-t-0 md:border-l lg:w-[320px]"
      aria-label="下载文件信息"
    >
      <div className={cn("overflow-hidden rounded-xl p-2.5", CARD_SURFACE_CLASS)}>
        <div className="flex min-w-0 gap-2.5">
          <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-muted">
            {cover ? (
              <img src={cover} alt="" className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center text-muted-foreground">
                <Download className="size-5" aria-hidden />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-semibold leading-5" title={item.title}>
              {item.title}
            </p>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {item.author.trim() || "本地下载"}
            </p>
          </div>
        </div>
      </div>

      <dl className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-card/60 px-3">
        <div className="flex items-center justify-between gap-3 py-2.5">
          <dt className="text-sm text-muted-foreground">画质</dt>
          <dd>
            <Badge variant="secondary">{item.quality_label || "未知"}</Badge>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2.5">
          <dt className="text-sm text-muted-foreground">时长</dt>
          <dd className="font-mono text-sm tabular-nums">{formatVideoDuration(item.duration)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2.5">
          <dt className="text-sm text-muted-foreground">文件大小</dt>
          <dd className="font-mono text-sm tabular-nums">
            {formatByteSize(item.total_bytes || item.downloaded_bytes)}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2">
        <Button variant="secondary" className="w-full justify-start" onClick={openWithSystemPlayer}>
          <ExternalLink data-icon="inline-start" aria-hidden />
          使用系统播放器
        </Button>
        {revealAvailable && (
          <Button variant="ghost" className="w-full justify-start" onClick={revealInFolder}>
            <FolderOpen data-icon="inline-start" aria-hidden />
            打开文件位置
          </Button>
        )}
      </div>
      <p className="px-1 text-sm leading-6 text-muted-foreground">
        正在播放应用内下载缓存；断网时仍可继续观看。
      </p>
    </aside>
  );
}

export function VideoDownloadPlaybackPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const supported = videoDownloadSupported();
  const downloadId = id?.trim() || "";
  const playback = useQuery({
    queryKey: [...VIDEO_DOWNLOAD_PLAYBACK_QUERY_KEY, downloadId],
    enabled: supported && Boolean(downloadId),
    queryFn: () => videoDownloadPlaybackInfo(downloadId),
    staleTime: 0,
    gcTime: 0,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
  });

  function goBack() {
    const historyIndex = (window.history.state as { idx?: unknown } | null)?.idx;
    if (shouldPopToVideoDownloadList(location.state, historyIndex)) {
      navigate(-1);
      return;
    }
    navigate(videoDownloadPlaybackReturnTarget(location.state), { replace: true });
  }

  const item = playback.data?.item ?? null;
  const title = item?.title.trim() || "本地下载";

  if (!supported) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
        <PlaybackState>
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Download aria-hidden />
              </EmptyMedia>
              <EmptyTitle>应用内播放仅在 rLive 客户端中可用</EmptyTitle>
              <EmptyDescription>
                本地下载缓存通过客户端内的受控文件服务播放，浏览器预览无法访问。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </PlaybackState>
      </div>
    );
  }

  if (!downloadId) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
        <PlaybackState>
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleAlert aria-hidden />
              </EmptyMedia>
              <EmptyTitle>下载地址无效</EmptyTitle>
              <EmptyDescription>返回下载列表后重新选择要播放的文件。</EmptyDescription>
            </EmptyHeader>
            <Button variant="secondary" onClick={goBack}>
              返回下载列表
            </Button>
          </Empty>
        </PlaybackState>
      </div>
    );
  }

  if (playback.isPending) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
        <PlaybackState>
          <div className="flex flex-col gap-3">
            <Skeleton className="aspect-video w-full rounded-xl" />
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden />
              正在准备本地播放…
            </div>
          </div>
        </PlaybackState>
      </div>
    );
  }

  if (playback.isError) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
        <PlaybackState>
          <ErrorState
            error={playback.error}
            title="无法打开本地下载"
            onRetry={() => void playback.refetch()}
          />
        </PlaybackState>
      </div>
    );
  }

  if (!playback.data?.url || !item) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
        <PlaybackState>
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleAlert aria-hidden />
              </EmptyMedia>
              <EmptyTitle>本地文件不可用</EmptyTitle>
              <EmptyDescription>下载可能已被删除或移动，返回下载列表刷新后重试。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </PlaybackState>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PlaybackTopBar title={title} onBack={goBack} />
      <main className="flex min-h-0 flex-1 flex-col bg-black md:flex-row">
        <section
          className="relative flex aspect-video w-full min-w-0 shrink-0 items-center justify-center bg-black md:aspect-auto md:min-h-0 md:flex-1"
          aria-label="本地下载播放器"
        >
          <LocalDownloadPlayer
            item={item}
            url={playback.data.url}
            progress={playback.data.progress}
            fill
          />
        </section>
        <DownloadDetails item={item} />
      </main>
    </div>
  );
}
