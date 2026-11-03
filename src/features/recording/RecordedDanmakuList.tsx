import { memo, useMemo } from "react";
import { ErrorState } from "@/shared/components/ErrorState";
import { VideoDanmakuList } from "@/features/video/VideoDanmakuList";
import type { PlaybackClock } from "@/features/video/videoPlaybackClock";
import type { RecordedDanmakuEntry } from "./recordedDanmaku";
import { recordedDanmakuListEntries } from "./recordedDanmakuListMapping";

export const RecordedDanmakuList = memo(function RecordedDanmakuList({
  entries,
  clock,
  included,
  loading,
  error,
  active,
  onRetry,
  onSeek,
}: {
  entries: readonly RecordedDanmakuEntry[];
  clock: PlaybackClock;
  included: boolean;
  loading: boolean;
  error: unknown;
  active: boolean;
  onRetry: () => void;
  onSeek: (positionMs: number) => void;
}) {
  const listEntries = useMemo(() => recordedDanmakuListEntries(entries), [entries]);

  if (!included) {
    return (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">这段录制未包含弹幕轨。</p>
    );
  }
  if (error) {
    return (
      <div className="p-3">
        <ErrorState error={error} title="录制弹幕加载失败" onRetry={onRetry} />
      </div>
    );
  }

  return (
    <VideoDanmakuList
      entries={listEntries}
      clock={clock}
      loading={loading}
      onSeek={onSeek}
      active={active}
      ariaLabel="录制弹幕"
      emptyText="这段录制没有可显示的弹幕"
    />
  );
});
