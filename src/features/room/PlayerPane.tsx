import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Pause,
  Play,
  Volume2,
  VolumeX,
  Maximize2,
  PictureInPicture2,
  MessageSquareText,
  Captions,
} from "lucide-react";
import type { PlayUrl } from "@/shared/types/live";
import { ErrorState } from "@/shared/components/ErrorState";
import { invokeCmd } from "@/shared/api/tauri";
import { DanmakuPanel } from "./DanmakuPanel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
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
  /** Bottom bar extras (quality, line, etc.). */
  bottomExtras?: React.ReactNode;
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
  bottomExtras,
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

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Video stage — hostRef must NOT cover chrome overlays (HWND sits on top) */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-black">
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

        {/* Controls under embed host so they stay clickable */}
        {showHost && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border bg-card px-2 py-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              title={paused ? "播放" : "暂停"}
              onClick={() => void togglePause()}
            >
              {paused ? (
                <Play className="fill-current" />
              ) : (
                <Pause className="fill-current" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon-sm"
              title={muted ? "取消静音" : "静音"}
              onClick={() => void toggleMute()}
            >
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </Button>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => void changeVolume(Number(e.target.value))}
              className="w-24 accent-primary"
              aria-label="音量"
            />

            <Separator orientation="vertical" className="mx-1 h-4" />

            <Button
              variant={danmakuOn ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setDanmakuOn((v) => !v)}
            >
              <MessageSquareText data-icon="inline-start" />
              弹幕
            </Button>
            <Button
              variant={osdOn ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setOsdOn((v) => !v)}
            >
              <Captions data-icon="inline-start" />
              飘屏
            </Button>

            {bottomExtras}

            <div className="ml-auto flex items-center gap-1">
              {status?.embed_mode && (
                <span className="mr-1 hidden text-[10px] text-muted-foreground sm:inline">
                  {status.embed_mode === "child"
                    ? "wid"
                    : status.embed_mode === "geometry"
                      ? "geo"
                      : "win"}
                </span>
              )}
              <Button variant="ghost" size="icon-sm" disabled title="画中画">
                <PictureInPicture2 />
              </Button>
              <Button variant="ghost" size="icon-sm" disabled title="全屏">
                <Maximize2 />
              </Button>
            </div>
          </div>
        )}
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
