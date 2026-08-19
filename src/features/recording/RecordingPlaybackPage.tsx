import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, CircleDot, MessageSquareText, Tv, Videotape } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import { ErrorState } from "@/shared/components/ErrorState";
import { SiteLogo } from "@/shared/components/SiteLogo";
import type { SiteId } from "@/shared/types/live";
import { RecordingPlayer } from "./RecordingPlayer";
import {
  formatRecordingDate,
  formatRecordingDuration,
  formatRecordingSize,
  RECORDING_PLAYBACK_QUERY_KEY,
  recordingErrorMessage,
  recordingPlaybackUrl,
  recordingProtocolLabel,
  recordingSupported,
  recordingUserGroupKey,
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
              aria-label="返回录制库"
              onClick={onBack}
            >
              <ChevronLeft aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="bottom">返回录制库</TooltipContent>
      </Tooltip>
      <p
        className="absolute inset-x-16 truncate text-center text-sm font-semibold tracking-tight text-foreground/90"
        title={title}
      >
        {title}
      </p>
    </header>
  );
}

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

function PlaybackSidebar({ item }: { item: RecordingItem }) {
  const userName = item.user_name.trim() || recordingSourceLabel(item);
  const avatar = normalizeImageUrl(item.user_avatar?.trim() || item.cover);

  return (
    <aside
      data-slot="recording-playback-sidebar"
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden border-t border-border/80 bg-sidebar md:w-[300px] md:flex-none md:border-t-0 md:border-l lg:w-[320px]"
      aria-label="录制信息"
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

      <div className="flex h-11 shrink-0 items-center border-b border-border/80 px-3">
        <h2 className="text-sm font-medium">录制信息</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
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
      </div>
    </aside>
  );
}

function PlaybackLayout({ item, children }: { item: RecordingItem; children: ReactNode }) {
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-black md:flex-row">
      <section
        className="relative flex aspect-video w-full min-w-0 shrink-0 items-center justify-center bg-black md:aspect-auto md:min-h-0 md:flex-1"
        aria-label="录制播放器"
      >
        {children}
      </section>
      <PlaybackSidebar item={item} />
    </main>
  );
}

export function RecordingPlaybackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { recordingId } = useParams<{ recordingId: string }>();
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

  function goBack() {
    const params = new URLSearchParams();
    if (item) params.set("user", recordingUserGroupKey(item));
    const platform = searchParams.get("platform");
    if (platform) params.set("platform", platform);
    const query = params.toString();
    navigate(query ? `/recordings?${query}` : "/recordings");
  }

  const title = item?.title || "录制回放";

  if (!supported) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
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
      </div>
    );
  }

  if (recordings.isPending) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
        <PlaybackPageState>
          <div className="flex flex-col gap-3">
            <Skeleton className="aspect-video w-full rounded-xl" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </PlaybackPageState>
      </div>
    );
  }

  if (recordings.isError) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
        <PlaybackPageState>
          <ErrorState
            error={recordings.error}
            title="无法读取录制信息"
            onRetry={() => void recordings.refetch()}
          />
        </PlaybackPageState>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
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
      </div>
    );
  }

  if (item.status === "recording") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PlaybackTopBar title={title} onBack={goBack} />
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
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PlaybackTopBar title={title} onBack={goBack} />
      <PlaybackLayout item={item}>
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
          <RecordingPlayer item={item} url={playback.data} fill />
        ) : null}
      </PlaybackLayout>
    </div>
  );
}
