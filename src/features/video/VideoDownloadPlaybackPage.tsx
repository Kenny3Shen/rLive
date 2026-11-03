import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  CircleAlert,
  Clock3,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
} from "lucide-react";
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
import { formatByteSize, normalizeVideoCoverUrl } from "@/lib/utils";
import { ErrorState } from "@/shared/components/ErrorState";
import { formatVideoDuration } from "./videoHistory";
import { LocalDownloadPlayer } from "./LocalDownloadPlayer";
import { parseDownloadedDanmaku } from "./videoDownloadDanmaku";
import type { VideoDanmakuEntry } from "./videoDanmaku";
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

const EMPTY_DANMAKU: readonly VideoDanmakuEntry[] = [];

function playbackErrorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

function PlaybackState({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background p-4 md:p-6">
      <div className="w-full max-w-xl">{children}</div>
    </main>
  );
}

function DownloadFooter({ item, onBack }: { item: VideoDownloadItem | null; onBack: () => void }) {
  const revealAvailable = videoDownloadCanReveal();
  const openWithSystemPlayer = () => {
    if (!item) return;
    void videoDownloadOpen(item.id).catch((error: unknown) =>
      notify.error("无法使用系统播放器打开", playbackErrorText(error)),
    );
  };
  const revealInFolder = () => {
    if (!item) return;
    void revealItemInDir(item.file_path).catch((error: unknown) =>
      notify.error("无法打开文件位置", playbackErrorText(error)),
    );
  };

  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/80 bg-sidebar/90 px-3 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))]">
      <Button
        variant="ghost"
        size="sm"
        className="max-md:h-10 max-md:touch-manipulation"
        onClick={onBack}
      >
        <ChevronLeft data-icon="inline-start" aria-hidden />
        返回下载列表
      </Button>
      {item && (
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="max-md:h-10 max-md:touch-manipulation"
            onClick={openWithSystemPlayer}
          >
            <ExternalLink data-icon="inline-start" aria-hidden />
            系统播放器
          </Button>
          {revealAvailable && (
            <Button
              variant="ghost"
              size="sm"
              className="max-md:h-10 max-md:touch-manipulation"
              onClick={revealInFolder}
            >
              <FolderOpen data-icon="inline-start" aria-hidden />
              打开文件位置
            </Button>
          )}
        </div>
      )}
    </footer>
  );
}

function PlaybackFrame({
  item,
  onBack,
  children,
}: {
  item: VideoDownloadItem | null;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PlaybackState>{children}</PlaybackState>
      <DownloadFooter item={item} onBack={onBack} />
    </div>
  );
}

function DownloadDetails({
  item,
  subtitleError,
  danmakuError,
}: {
  item: VideoDownloadItem;
  subtitleError: string | null;
  danmakuError: string | null;
}) {
  const cover = normalizeVideoCoverUrl(item.cover);

  return (
    <aside
      data-slot="download-playback-sidebar"
      className="relative isolate flex min-h-0 w-full flex-1 flex-col border-t border-border/80 bg-sidebar lg:w-[320px] lg:flex-none lg:border-t-0 lg:border-l xl:w-[340px]"
      aria-label="下载文件信息"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pt-3 pb-4">
        <section
          className="overflow-hidden rounded-xl border border-border-subtle bg-card/75 px-2.5 py-2 shadow-sm"
          aria-label="本地文件"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-border-subtle">
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
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {item.author.trim() || "本地下载"}
              </p>
            </div>
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border-subtle pt-2">
            <Badge variant="secondary">{item.quality_label || "未知画质"}</Badge>
            <Badge variant="outline">
              <Clock3 data-icon="inline-start" aria-hidden />
              {formatVideoDuration(item.duration)}
            </Badge>
            <Badge variant="outline">
              <HardDrive data-icon="inline-start" aria-hidden />
              {formatByteSize(item.total_bytes || item.downloaded_bytes)}
            </Badge>
          </div>
        </section>

        {subtitleError && <ErrorState error={subtitleError} title="字幕缓存不完整" />}
        {danmakuError && <ErrorState error={danmakuError} title="弹幕缓存不可用或不完整" />}
      </div>
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
  const danmakuUrl = playback.data?.danmaku_url;
  const danmaku = useQuery({
    queryKey: [...VIDEO_DOWNLOAD_PLAYBACK_QUERY_KEY, downloadId, "danmaku", danmakuUrl],
    enabled: Boolean(danmakuUrl),
    queryFn: async ({ signal }) => {
      if (!danmakuUrl) throw new Error("未缓存弹幕");
      const response = await fetch(danmakuUrl, { signal });
      if (!response.ok) throw new Error("本机弹幕缓存读取失败，重新下载可恢复");
      return parseDownloadedDanmaku(await response.json());
    },
    staleTime: Infinity,
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
  const subtitles = playback.data?.subtitles ?? [];
  const subtitleError = playback.data?.subtitle_error || null;
  const danmakuError =
    [playback.data?.danmaku_error, danmaku.isError ? playbackErrorText(danmaku.error) : null]
      .filter(Boolean)
      .join("；") || null;

  if (!supported) {
    return (
      <PlaybackFrame item={item} onBack={goBack}>
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
      </PlaybackFrame>
    );
  }

  if (!downloadId) {
    return (
      <PlaybackFrame item={item} onBack={goBack}>
        <Empty className="min-h-64 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleAlert aria-hidden />
            </EmptyMedia>
            <EmptyTitle>下载地址无效</EmptyTitle>
            <EmptyDescription>返回下载列表后重新选择要播放的文件。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PlaybackFrame>
    );
  }

  if (playback.isPending) {
    return (
      <PlaybackFrame item={item} onBack={goBack}>
        <div className="flex flex-col gap-3">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner data-icon="inline-start" aria-hidden />
            正在准备本地播放…
          </div>
        </div>
      </PlaybackFrame>
    );
  }

  if (playback.isError) {
    return (
      <PlaybackFrame item={item} onBack={goBack}>
        <ErrorState
          error={playback.error}
          title="无法打开本地下载"
          onRetry={() => void playback.refetch()}
        />
      </PlaybackFrame>
    );
  }

  if (!playback.data?.url || !item) {
    return (
      <PlaybackFrame item={item} onBack={goBack}>
        <Empty className="min-h-64 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleAlert aria-hidden />
            </EmptyMedia>
            <EmptyTitle>本地文件不可用</EmptyTitle>
            <EmptyDescription>下载可能已被删除或移动，返回下载列表刷新后重试。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PlaybackFrame>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <main className="flex min-h-0 flex-1 flex-col bg-black lg:flex-row">
        <section
          className="relative flex aspect-video h-auto w-full min-w-0 flex-none items-center justify-center bg-black max-lg:max-h-[70%] lg:aspect-auto lg:h-full lg:min-h-0 lg:flex-1"
          aria-label="本地下载播放器"
        >
          <LocalDownloadPlayer
            item={item}
            url={playback.data.url}
            progress={playback.data.progress}
            subtitles={subtitles}
            danmakuEntries={danmaku.data ?? EMPTY_DANMAKU}
            danmakuAvailable={danmaku.isSuccess}
            onNavigateBack={goBack}
            fill
          />
        </section>
        <DownloadDetails item={item} subtitleError={subtitleError} danmakuError={danmakuError} />
      </main>
      <DownloadFooter item={item} onBack={goBack} />
    </div>
  );
}
