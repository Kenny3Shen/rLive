import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Captions,
  ChevronLeft,
  CircleDot,
  FolderOpen,
  MessageSquareText,
  Tv,
  Videotape,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DanmakuSettingsPanel } from "@/features/room/DanmakuSettingsPanel";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import { normalizeImageUrl } from "@/lib/utils";
import { ErrorState } from "@/shared/components/ErrorState";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { createPlaybackClock, type PlaybackClock } from "@/features/video/videoPlaybackClock";
import { RecordingPlayer, type RecordingPlayerHandle } from "./RecordingPlayer";
import { RecordedDanmakuList } from "./RecordedDanmakuList";
import { useRecordedDanmakuTrack } from "./useRecordedDanmakuTrack";
import {
  recordingIdFromPlaybackParams,
  recordingPlaybackReturnTarget,
  shouldPopToRecordingLibrary,
} from "./recordingRoute";
import {
  formatRecordingDate,
  formatRecordingDuration,
  formatRecordingSize,
  RECORDING_PLAYBACK_QUERY_KEY,
  recordingErrorMessage,
  recordingPlaybackUrl,
  recordingProtocolLabel,
  recordingSourceLabel,
  recordingStatusLabel,
  recordingSupported,
  exportRecordingDanmakuAss,
  useRecordings,
  type RecordingItem,
} from "./recording";

function PlaybackPageState({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background p-4 md:p-6">
      <div className="w-full max-w-xl">{children}</div>
    </main>
  );
}

function PlaybackDetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 py-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

type PlaybackDanmaku = ReturnType<typeof useRecordedDanmakuTrack> & {
  clock: PlaybackClock;
  onSeek: (positionMs: number) => void;
};

function PlaybackSidebar({ item, danmaku }: { item: RecordingItem; danmaku: PlaybackDanmaku }) {
  // 「信息 / 弹幕 / 设置」页签；换录制不保留页签状态（组件随 PlaybackLayout 重挂）。
  const [sidebarTab, setSidebarTab] = useState<"info" | "danmaku" | "settings">("info");
  const userName = item.user_name.trim() || recordingSourceLabel(item);
  const avatar = normalizeImageUrl(item.user_avatar?.trim() || item.cover);

  return (
    <aside
      data-slot="recording-playback-sidebar"
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden border-t border-border/80 bg-sidebar md:w-[300px] md:flex-none md:border-t-0 md:border-l lg:w-[320px]"
      aria-label="录制回放侧栏"
    >
      <section
        className="shrink-0 border-b border-border px-2.5 py-2"
        aria-label={`主播：${userName}`}
      >
        <div className="overflow-hidden rounded-xl border border-border-subtle bg-card/75 px-2.5 py-2 shadow-sm">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar size="lg" className="size-11 ring-1 ring-border/80">
              <AvatarImage src={avatar} alt="" referrerPolicy="no-referrer" />
              <AvatarFallback className="font-medium">
                {Array.from(userName)[0] ?? "?"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-sm font-semibold leading-5 tracking-tight"
                title={userName}
              >
                {userName}
              </p>
              <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {item.site_id ? (
                  <SiteLogo siteId={item.site_id} className="size-3.5" />
                ) : (
                  <Tv className="size-3.5" aria-hidden />
                )}
                <span className="truncate">{recordingSourceLabel(item)}</span>
                {item.room_id && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="truncate tabular-nums">{item.room_id}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 页签固定在侧栏顶部：「信息」保留原录制详情，「弹幕」查看整条录制轨，
          「设置」复用直播弹幕偏好面板。 */}
      <Tabs
        value={sidebarTab}
        onValueChange={(value) => setSidebarTab(value as "info" | "danmaku" | "settings")}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex h-11 shrink-0 items-center border-b border-border/80">
          <TabsList
            variant="line"
            className="h-11! min-w-0 flex-1 justify-start rounded-none bg-transparent px-2"
          >
            <TabsTrigger value="info" className="px-3 text-sm">
              录制信息
            </TabsTrigger>
            <TabsTrigger value="danmaku" className="px-3 text-sm">
              弹幕
            </TabsTrigger>
            <TabsTrigger value="settings" className="px-3 text-sm">
              设置
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="info" className="min-h-0 flex-1 overflow-y-auto px-3">
          <dl className="divide-y divide-border-subtle">
            <PlaybackDetailRow label="开始时间">
              {formatRecordingDate(item.started_at)}
            </PlaybackDetailRow>
            <PlaybackDetailRow label="时长">
              <span className="font-mono tabular-nums">
                {formatRecordingDuration(item.duration_ms)}
              </span>
            </PlaybackDetailRow>
            <PlaybackDetailRow label="文件大小">
              <span className="font-mono tabular-nums">{formatRecordingSize(item.size_bytes)}</span>
            </PlaybackDetailRow>
            <PlaybackDetailRow label="格式">
              <Badge variant="outline">{recordingProtocolLabel(item.protocol)}</Badge>
            </PlaybackDetailRow>
            <PlaybackDetailRow label="弹幕">
              {item.include_danmaku ? (
                <span className="inline-flex items-center gap-1.5">
                  <MessageSquareText className="size-3.5 text-muted-foreground" aria-hidden />
                  {item.danmaku_count} 条
                </span>
              ) : (
                "未录制"
              )}
            </PlaybackDetailRow>
            <PlaybackDetailRow label="状态">
              <Badge variant={item.status === "failed" ? "destructive" : "secondary"}>
                {item.status === "recording" && <CircleDot data-icon="inline-start" aria-hidden />}
                {recordingStatusLabel(item.status)}
              </Badge>
            </PlaybackDetailRow>
          </dl>

          {item.error && (
            <ErrorState
              error={recordingErrorMessage(item.error)}
              title={item.status === "failed" ? "录制失败" : "录制过程中断"}
              className="my-3"
            />
          )}
        </TabsContent>
        <TabsContent value="danmaku" className="min-h-0 flex-1 overflow-hidden">
          <RecordedDanmakuList
            key={item.id}
            entries={danmaku.entries}
            clock={danmaku.clock}
            included={danmaku.included}
            loading={danmaku.loading}
            error={danmaku.error}
            active={sidebarTab === "danmaku"}
            onRetry={danmaku.refetch}
            onSeek={danmaku.onSeek}
          />
        </TabsContent>
        <TabsContent value="settings" className="min-h-0 flex-1 overflow-hidden">
          <DanmakuSettingsPanel className="h-full" showAsrCard={false} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function PlaybackLayout({
  item,
  danmaku,
  children,
}: {
  item: RecordingItem;
  danmaku: PlaybackDanmaku;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-black md:flex-row">
      <section
        className="relative flex aspect-video w-full min-w-0 shrink-0 items-center justify-center bg-black md:aspect-auto md:min-h-0 md:flex-1"
        aria-label="录制播放器"
      >
        {children}
      </section>
      <PlaybackSidebar item={item} danmaku={danmaku} />
    </main>
  );
}

function PlaybackFooter({
  item,
  onBack,
  onReveal,
  onExportAss,
  revealing,
  exportingAss,
}: {
  item: RecordingItem | null;
  onBack: () => void;
  onReveal: (path: string) => void;
  onExportAss: (id: string) => void;
  revealing: boolean;
  exportingAss: boolean;
}) {
  const exportable = Boolean(
    item && item.status !== "recording" && item.include_danmaku && item.danmaku_count > 0,
  );

  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/80 bg-sidebar/90 px-3 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))]">
      <Button
        variant="ghost"
        size="sm"
        className="max-md:h-10 max-md:touch-manipulation"
        onClick={onBack}
      >
        <ChevronLeft data-icon="inline-start" aria-hidden />
        返回录制库
      </Button>
      {item && (
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {exportable && (
            <Button
              variant="ghost"
              size="sm"
              className="max-md:h-10 max-md:touch-manipulation"
              disabled={exportingAss}
              onClick={() => onExportAss(item.id)}
            >
              {exportingAss ? (
                <Spinner data-icon="inline-start" aria-hidden />
              ) : (
                <Captions data-icon="inline-start" aria-hidden />
              )}
              导出弹幕字幕
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="max-md:h-10 max-md:touch-manipulation"
            disabled={revealing}
            onClick={() => onReveal(item.file_path)}
          >
            {revealing ? (
              <Spinner data-icon="inline-start" aria-hidden />
            ) : (
              <FolderOpen data-icon="inline-start" aria-hidden />
            )}
            打开文件位置
          </Button>
        </div>
      )}
    </footer>
  );
}

export function RecordingPlaybackPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { roomDir, sessionDir } = useParams<{
    roomDir: string;
    sessionDir: string;
  }>();
  // id 跨越两个路由段，因此在这里重新拼接，
  // 而不是从单个参数读取。
  const recordingId = recordingIdFromPlaybackParams(roomDir, sessionDir);
  const supported = recordingSupported();
  const recordings = useRecordings();
  const item = recordings.data?.find((entry) => entry.id === recordingId) ?? null;
  const playback = useQuery({
    queryKey: [RECORDING_PLAYBACK_QUERY_KEY, recordingId],
    enabled: supported && Boolean(item) && item?.status !== "recording",
    queryFn: async () => {
      return recordingPlaybackUrl(recordingId!);
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const danmakuTrack = useRecordedDanmakuTrack(item);
  const [playbackClock] = useState(() => createPlaybackClock());
  const playerControllerRef = useRef<RecordingPlayerHandle | null>(null);
  const seekRecordedDanmaku = useCallback((positionMs: number) => {
    playerControllerRef.current?.seek(positionMs / 1_000);
  }, []);
  const revealMutation = useMutation({
    mutationFn: (path: string) => revealItemInDir(path),
    onError: (error) => notify.error("无法打开文件位置", recordingErrorMessage(error)),
  });
  const exportAssMutation = useMutation({
    mutationFn: exportRecordingDanmakuAss,
    onSuccess: (path) => notify.success(`弹幕字幕已导出：${path}`),
    onError: (error) => notify.error("导出弹幕字幕失败", recordingErrorMessage(error)),
  });

  function goBack() {
    const historyIndex = (window.history.state as { idx?: unknown } | null)?.idx;
    if (shouldPopToRecordingLibrary(location.state, historyIndex)) {
      navigate(-1);
      return;
    }
    navigate(recordingPlaybackReturnTarget(searchParams.toString(), location.state), {
      replace: true,
    });
  }

  const footer = (
    <PlaybackFooter
      item={item}
      onBack={goBack}
      onReveal={revealMutation.mutate}
      onExportAss={exportAssMutation.mutate}
      revealing={revealMutation.isPending}
      exportingAss={exportAssMutation.isPending}
    />
  );

  if (!supported) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackPageState>
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Videotape aria-hidden />
              </EmptyMedia>
              <EmptyTitle>录制功能仅支持桌面端</EmptyTitle>
              <EmptyDescription>请在 Windows、macOS 或 Linux 桌面版中回放录制。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </PlaybackPageState>
        {footer}
      </div>
    );
  }

  if (recordings.isPending) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackPageState>
          <div className="flex flex-col gap-3">
            <Skeleton className="aspect-video w-full rounded-xl" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </PlaybackPageState>
        {footer}
      </div>
    );
  }

  if (recordings.isError) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackPageState>
          <ErrorState
            error={recordings.error}
            title="无法读取录制信息"
            onRetry={() => void recordings.refetch()}
          />
        </PlaybackPageState>
        {footer}
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackPageState>
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Videotape aria-hidden />
              </EmptyMedia>
              <EmptyTitle>找不到这段录制</EmptyTitle>
              <EmptyDescription>录制可能已被删除，或当前设备还没有加载到它。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </PlaybackPageState>
        {footer}
      </div>
    );
  }

  if (item.status === "recording") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackPageState>
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleDot className="text-destructive" aria-hidden />
              </EmptyMedia>
              <EmptyTitle>这段内容仍在录制</EmptyTitle>
              <EmptyDescription>录制结束并保存后即可进入回放。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </PlaybackPageState>
        {footer}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PlaybackLayout
        item={item}
        danmaku={{
          ...danmakuTrack,
          clock: playbackClock,
          onSeek: seekRecordedDanmaku,
        }}
      >
        {playback.isPending ? (
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <Spinner className="size-7 text-primary" aria-label="正在准备录制回放" />
            <span>正在准备录制回放…</span>
          </div>
        ) : playback.isError ? (
          <div className="w-full max-w-md p-5">
            <ErrorState
              error={playback.error}
              title="无法打开这段录制"
              className="bg-card shadow-2xl shadow-black/50"
              onRetry={() => void playback.refetch()}
            />
          </div>
        ) : playback.data ? (
          <RecordingPlayer
            item={item}
            url={playback.data}
            danmakuEntries={danmakuTrack.entries}
            danmakuAvailable={danmakuTrack.available && !danmakuTrack.error}
            playbackClock={playbackClock}
            controllerRef={playerControllerRef}
            onNavigateBack={goBack}
            fill
          />
        ) : null}
      </PlaybackLayout>
      {footer}
    </div>
  );
}
