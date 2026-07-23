import type { PlayUrl } from "../../shared/types/live";
import { ErrorState } from "../../shared/components/ErrorState";

type PlayerPaneProps = {
  playUrl: PlayUrl | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  title?: string;
};

/** Placeholder player region — Task 9 wires external mpv. */
export function PlayerPane({
  playUrl,
  loading,
  error,
  onRetry,
  title,
}: PlayerPaneProps) {
  return (
    <div className="relative flex aspect-video w-full flex-col overflow-hidden rounded-lg border border-zinc-200 bg-zinc-900 text-zinc-100 dark:border-zinc-700">
      {loading && (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          Resolving play URL…
        </div>
      )}

      {!loading && error != null && (
        <div className="flex flex-1 items-center justify-center p-4">
          <ErrorState
            error={error}
            title="Playback unavailable"
            onRetry={onRetry}
          />
        </div>
      )}

      {!loading && error == null && playUrl && (
        <div className="flex flex-1 flex-col justify-end gap-2 p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-400">
            Stream ready (mpv in Task 9)
          </p>
          {title && <p className="text-sm font-medium line-clamp-2">{title}</p>}
          <p className="break-all font-mono text-[11px] text-zinc-500 line-clamp-3">
            {playUrl.url}
          </p>
        </div>
      )}

      {!loading && error == null && !playUrl && (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          No stream selected
        </div>
      )}
    </div>
  );
}
