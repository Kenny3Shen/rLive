import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleDot, MessageSquareText, Videotape } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
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
import { ErrorState } from "@/shared/components/ErrorState";
import { SITE_LABELS } from "@/lib/utils";
import type { SiteId } from "@/shared/types/live";
import { RecordingPlayer } from "./RecordingPlayer";
import {
  formatRecordingDate,
  formatRecordingDuration,
  formatRecordingSize,
  RECORDINGS_QUERY_KEY,
  RECORDING_PLAYBACK_QUERY_KEY,
  recordingErrorMessage,
  recordingPlaybackUrl,
  recordingProtocolLabel,
  recordingSupported,
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

function PlaybackPageHeader({ item, onBack }: { item: RecordingItem; onBack: () => void }) {
  return (
    <header className="flex min-w-0 items-start gap-3">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="mt-0.5 shrink-0"
        aria-label="返回录制库"
        title="返回录制库"
        onClick={onBack}
      >
        <ArrowLeft aria-hidden />
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <Videotape className="size-3.5 text-primary" aria-hidden />
          <span>录制回放</span>
          <span aria-hidden>·</span>
          <span>{recordingSourceLabel(item)}</span>
        </div>
        <h1 className="truncate font-heading text-2xl font-semibold tracking-tight">
          {item.title}
        </h1>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>{item.user_name || recordingSourceLabel(item)}</span>
          <span aria-hidden>·</span>
          <span>{formatRecordingDate(item.started_at)}</span>
          <Badge variant="outline">{recordingProtocolLabel(item.protocol)}</Badge>
          {item.include_danmaku && (
            <Badge variant="outline">
              <MessageSquareText data-icon="inline-start" aria-hidden />
              {item.danmaku_count} 条弹幕
            </Badge>
          )}
          <Badge variant={item.status === "failed" ? "destructive" : "secondary"}>
            {item.status === "recording" && <CircleDot data-icon="inline-start" aria-hidden />}
            {recordingStatusLabel(item.status)}
          </Badge>
        </div>
      </div>
    </header>
  );
}

function PlaybackMetadata({ item }: { item: RecordingItem }) {
  return (
    <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t border-border-subtle pt-4 text-sm sm:grid-cols-4">
      <div className="flex min-w-0 flex-col gap-1">
        <dt className="text-xs text-muted-foreground">时长</dt>
        <dd className="font-mono">{formatRecordingDuration(item.duration_ms)}</dd>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <dt className="text-xs text-muted-foreground">大小</dt>
        <dd className="font-mono">{formatRecordingSize(item.size_bytes)}</dd>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <dt className="text-xs text-muted-foreground">来源</dt>
        <dd className="truncate">{recordingSourceLabel(item)}</dd>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <dt className="text-xs text-muted-foreground">状态</dt>
        <dd>{recordingStatusLabel(item.status)}</dd>
      </div>
    </dl>
  );
}

export function RecordingPlaybackPage() {
  const navigate = useNavigate();
  const { recordingId } = useParams<{ recordingId: string }>();
  const queryClient = useQueryClient();
  const supported = recordingSupported();
  const recordings = useRecordings();
  const item = recordings.data?.find((entry) => entry.id === recordingId) ?? null;
  const playback = useQuery({
    queryKey: [RECORDING_PLAYBACK_QUERY_KEY, recordingId],
    enabled: supported && Boolean(item) && item?.status !== "recording",
    queryFn: async () => {
      const url = await recordingPlaybackUrl(recordingId!);
      // Legacy playback normalization can update duration metadata. Keep the
      // list cache fresh so returning to the library shows the corrected value.
      await queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
      return url;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  function goBack() {
    navigate(
      item ? `/recordings?user=${encodeURIComponent(recordingUserLabel(item))}` : "/recordings",
    );
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

  if (recordings.isPending) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-[1280px] flex-col gap-5 p-4 md:p-6">
        <Skeleton className="h-10 w-2/3 max-w-xl" />
        <Skeleton className="aspect-video w-full rounded-xl" />
      </main>
    );
  }

  if (recordings.isError) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-[1280px] flex-col gap-5 p-4 md:p-6">
        <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={goBack}>
          <ArrowLeft data-icon="inline-start" aria-hidden />
          返回录制库
        </Button>
        <ErrorState
          error={recordings.error}
          title="无法读取录制信息"
          onRetry={() => void recordings.refetch()}
        />
      </main>
    );
  }

  if (!item) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-[1280px] flex-col gap-5 p-4 md:p-6">
        <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={goBack}>
          <ArrowLeft data-icon="inline-start" aria-hidden />
          返回录制库
        </Button>
        <Empty className="min-h-64 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Videotape aria-hidden />
            </EmptyMedia>
            <EmptyTitle>找不到这段录制</EmptyTitle>
            <EmptyDescription>录制可能已被删除，或当前设备还没有加载到它。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    );
  }

  if (item.status === "recording") {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-[1280px] flex-col gap-5 p-4 md:p-6">
        <PlaybackPageHeader item={item} onBack={goBack} />
        <Empty className="min-h-64 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleDot className="text-destructive" aria-hidden />
            </EmptyMedia>
            <EmptyTitle>这段内容仍在录制</EmptyTitle>
            <EmptyDescription>录制结束并保存后即可进入回放。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-[1280px] flex-col gap-5 p-4 md:p-6">
      <PlaybackPageHeader item={item} onBack={goBack} />
      {playback.isPending ? (
        <Skeleton className="aspect-video w-full rounded-xl" />
      ) : playback.isError ? (
        <ErrorState
          error={playback.error}
          title="无法打开这段录制"
          onRetry={() => void playback.refetch()}
        />
      ) : playback.data ? (
        <section className="flex min-w-0 flex-col gap-4" aria-label="录制播放器">
          <RecordingPlayer item={item} url={playback.data} />
          <PlaybackMetadata item={item} />
          {item.error && (
            <ErrorState
              error={recordingErrorMessage(item.error)}
              title={item.status === "failed" ? "录制失败" : "录制过程中断"}
            />
          )}
        </section>
      ) : null}
    </main>
  );
}
