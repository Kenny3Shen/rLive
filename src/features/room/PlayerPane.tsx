import { useEffect, useState } from "react";
import type { PlayUrl } from "../../shared/types/live";
import { ErrorState } from "../../shared/components/ErrorState";
import { invokeCmd } from "../../shared/api/tauri";

type PlayerPaneProps = {
  playUrl: PlayUrl | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  title?: string;
};

type PlayerStatus = {
  running: boolean;
  mpv_path: string;
};

/** External mpv player controller UI. */
export function PlayerPane({
  playUrl,
  loading,
  error,
  onRetry,
  title,
}: PlayerPaneProps) {
  const [mpvError, setMpvError] = useState<unknown>(null);
  const [status, setStatus] = useState<PlayerStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!playUrl) {
      void invokeCmd("player_stop").catch(() => {});
      setMpvError(null);
      return;
    }

    setMpvError(null);
    void (async () => {
      try {
        await invokeCmd("player_open", {
          url: playUrl.url,
          headers: playUrl.headers,
          title: title ?? null,
        });
        if (!cancelled) {
          const st = await invokeCmd<PlayerStatus>("player_status");
          setStatus(st);
        }
      } catch (e) {
        if (!cancelled) setMpvError(e);
      }
    })();

    return () => {
      cancelled = true;
      void invokeCmd("player_stop").catch(() => {});
    };
  }, [playUrl?.url, title]);

  // When quality changes URL without remount, reload.
  useEffect(() => {
    if (!playUrl) return;
    // open effect already handles url changes via dependency.
  }, [playUrl?.url]);

  const displayError = error ?? mpvError;

  return (
    <div className="relative flex aspect-video w-full flex-col overflow-hidden rounded-lg border border-zinc-200 bg-zinc-900 text-zinc-100 dark:border-zinc-700">
      {loading && (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          Resolving play URL…
        </div>
      )}

      {!loading && displayError != null && (
        <div className="flex flex-1 items-center justify-center p-4">
          <ErrorState
            error={displayError}
            title="Playback unavailable"
            onRetry={onRetry}
          />
        </div>
      )}

      {!loading && displayError == null && playUrl && (
        <div className="flex flex-1 flex-col justify-end gap-2 p-4">
          <p className="text-xs uppercase tracking-wide text-emerald-400/90">
            {status?.running ? "mpv running" : "mpv launched"}
          </p>
          {title && <p className="text-sm font-medium line-clamp-2">{title}</p>}
          {status?.mpv_path && (
            <p className="font-mono text-[11px] text-zinc-500">
              {status.mpv_path}
            </p>
          )}
          <p className="break-all font-mono text-[11px] text-zinc-500 line-clamp-2">
            {playUrl.url}
          </p>
        </div>
      )}

      {!loading && displayError == null && !playUrl && (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          No stream selected
        </div>
      )}
    </div>
  );
}
