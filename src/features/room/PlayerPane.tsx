import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PlayUrl } from "@/shared/types/live";
import { ErrorState } from "@/shared/components/ErrorState";
import { invokeCmd } from "@/shared/api/tauri";
import { DanmakuPanel } from "./DanmakuPanel";
import { PlayerControls } from "./PlayerControls";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type PlayerPaneProps = {
  playUrl: PlayUrl | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  title?: string;
  danmakuActive?: boolean;
  danmakuStatusText?: string | null;
  /** Right-side meta (avatar, name…) rendered above chat. */
  sideHeader?: React.ReactNode;
  qualities?: { quality: string }[];
  qualityIndex?: number;
  onQualityChange?: (index: number) => void;
  lines?: { url: string }[];
  lineIndex?: number;
  onLineChange?: (index: number) => void;
  onToggleFullscreen?: () => void;
};

type PlayerStatus = {
  running: boolean;
  mpv_path: string;
  paused: boolean;
  volume: number;
  embed_mode: "child" | "geometry" | "window";
};

type Bounds = { x: number; y: number; width: number; height: number };

async function measureClientBounds(el: HTMLElement): Promise<Bounds | null> {
  try {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return {
      x: Math.round(rect.left * factor),
      y: Math.round(rect.top * factor),
      width: Math.max(16, Math.round(rect.width * factor)),
      height: Math.max(16, Math.round(rect.height * factor)),
    };
  } catch {
    return null;
  }
}

export function PlayerPane({
  playUrl,
  loading,
  error,
  onRetry,
  title,
  danmakuActive = false,
  danmakuStatusText,
  sideHeader,
  qualities = [],
  qualityIndex = 0,
  onQualityChange,
  lines = [],
  lineIndex = 0,
  onLineChange,
  onToggleFullscreen,
}: PlayerPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mpvError, setMpvError] = useState<unknown>(null);
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(80);
  const [muted, setMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(80);
  const [danmakuOn, setDanmakuOn] = useState(true);
  const [osdOn, setOsdOn] = useState(true);

  const refreshStatus = useCallback(async () => {
    try {
      const st = await invokeCmd<PlayerStatus>("player_status");
      setStatus(st);
      setPaused(st.paused);
      setVolume(st.volume);
    } catch {
      /* ignore */
    }
  }, []);

  const pushBounds = useCallback(async () => {
    const el = hostRef.current;
    if (!el) return;
    const bounds = await measureClientBounds(el);
    if (!bounds) return;
    try {
      await invokeCmd("player_set_bounds", { bounds });
    } catch {
      /* not running */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!playUrl) {
      void invokeCmd("player_stop").catch(() => {});
      setMpvError(null);
      setStatus(null);
      return;
    }

    setMpvError(null);
    void (async () => {
      try {
        const bounds = hostRef.current
          ? await measureClientBounds(hostRef.current)
          : null;
        await invokeCmd("player_open", {
          url: playUrl.url,
          headers: playUrl.headers,
          title: title ?? null,
          bounds,
          preferChild: true,
        });
        if (!cancelled) {
          await refreshStatus();
          window.setTimeout(() => void pushBounds(), 120);
          window.setTimeout(() => void pushBounds(), 400);
        }
      } catch (e) {
        if (!cancelled) setMpvError(e);
      }
    })();

    return () => {
      cancelled = true;
      void invokeCmd("player_stop").catch(() => {});
    };
  }, [playUrl?.url, title, refreshStatus, pushBounds]);

  useEffect(() => {
    if (!playUrl) return;
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => void pushBounds());
    ro.observe(el);
    const onWin = () => void pushBounds();
    window.addEventListener("resize", onWin);
    const timer = window.setInterval(() => void pushBounds(), 400);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWin);
      window.clearInterval(timer);
    };
  }, [playUrl?.url, pushBounds]);

  async function togglePause() {
    const next = !paused;
    try {
      await invokeCmd("player_set_pause", { paused: next });
      setPaused(next);
      await refreshStatus();
    } catch (e) {
      setMpvError(e);
    }
  }

  async function changeVolume(v: number) {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    setVolume(vol);
    setMuted(vol === 0);
    try {
      await invokeCmd("player_set_volume", { volume: vol });
    } catch {
      /* ignore */
    }
  }

  async function toggleMute() {
    if (muted || volume === 0) {
      const restore = prevVolume || 80;
      setMuted(false);
      await changeVolume(restore);
    } else {
      setPrevVolume(volume);
      setMuted(true);
      await changeVolume(0);
    }
  }

  const displayError = error ?? mpvError;
  const showHost = !loading && displayError == null && !!playUrl;
  const transportDisabled = !showHost;

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Video stage — hostRef must NOT cover chrome overlays (HWND sits on top) */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-black">
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={hostRef} className="relative min-h-0 flex-1 bg-black">
            {loading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                <Spinner className="size-8 text-primary" />
                <p className="text-sm">正在解析线路…</p>
              </div>
            )}
            {!loading && displayError != null && (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <div className="w-full max-w-md">
                  <ErrorState
                    error={displayError}
                    title="播放不可用"
                    onRetry={onRetry}
                  />
                </div>
              </div>
            )}
            {!loading && displayError == null && !playUrl && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                未选择流
              </div>
            )}
            {showHost && !status?.running && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <Spinner className="size-8 text-white/70" />
              </div>
            )}
          </div>

          {/* Controls under embed host so they stay clickable (never inside HWND host) */}
          <PlayerControls
            paused={paused}
            volume={volume}
            muted={muted}
            danmakuOn={danmakuOn}
            osdOn={osdOn}
            qualities={qualities}
            qualityIndex={qualityIndex}
            lines={lines}
            lineIndex={lineIndex}
            disabled={transportDisabled}
            onTogglePause={() => void togglePause()}
            onVolume={(v) => void changeVolume(v)}
            onToggleMute={() => void toggleMute()}
            onToggleDanmaku={() => setDanmakuOn((v) => !v)}
            onToggleOsd={() => setOsdOn((v) => !v)}
            onQualityChange={onQualityChange ?? (() => {})}
            onLineChange={onLineChange ?? (() => {})}
            onToggleFullscreen={
              onToggleFullscreen ??
              (() => {
                /* Task 2: fullscreen */
              })
            }
          />
        </div>
      </div>

      {/* Right panel — always outside HWND */}
      {danmakuOn && (
        <aside
          className={cn(
            "flex w-[300px] shrink-0 flex-col border-l border-border bg-sidebar lg:w-[320px]",
            "max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-10 max-md:h-56 max-md:w-full max-md:border-t max-md:border-l-0",
          )}
        >
          {sideHeader}
          <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList
              variant="line"
              className="w-full justify-start rounded-none border-b border-border bg-transparent px-2"
            >
              <TabsTrigger value="chat">聊天</TabsTrigger>
              <TabsTrigger value="sc">SC</TabsTrigger>
            </TabsList>
            <TabsContent
              value="chat"
              className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
            >
              <DanmakuPanel
                active={danmakuActive}
                osd={osdOn && !!playUrl}
                statusText={danmakuStatusText}
                className="h-full"
              />
            </TabsContent>
            <TabsContent value="sc" className="mt-0 min-h-0 flex-1">
              <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
                Super Chat 将在后续版本展示
              </div>
            </TabsContent>
          </Tabs>
        </aside>
      )}
    </div>
  );
}
