import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { AlertCircle, Radio, Tv } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { createSerialTaskQueue } from "@/features/room/player/serialTaskQueue";
import { loadMpegts } from "@/features/room/player/useWebPlayer";
import type { Player as MpegtsPlayer } from "@/vendor/mpegts";
import type { IptvChannel } from "./types";

type PlaybackStatus = "idle" | "connecting" | "ready" | "playing" | "error";

// The localhost stream proxy is application-global. This queue keeps channel
// changes orderly within the IPTV page; each proxy session additionally has a
// unique owner ID so an old cleanup cannot stop a newer source.
const proxyQueue = createSerialTaskQueue();
let playerInstanceSequence = 0;
const EMPTY_HEADERS: Record<string, string> = {};

function nextPlayerId(): string {
  playerInstanceSequence = (playerInstanceSequence + 1) % Number.MAX_SAFE_INTEGER;
  const entropy = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `iptv-player-${entropy}-${playerInstanceSequence}`;
}

function isMpegTransportStream(url: string): boolean {
  return /\.(?:flv|ts|m2ts)(?:[?#]|$)/i.test(url) || /[?&](?:format|type)=(?:flv|ts)/i.test(url);
}

function isProgressiveVideo(url: string): boolean {
  return /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(url);
}

type IptvPlayerProps = {
  channel: IptvChannel | null;
  reloadToken: number;
};

/**
 * IPTV playback uses a dedicated HLS path (hls.js) rather than routing a
 * manifest through mpegts.js. The local proxy rewrites nested playlists,
 * keys, and segments so HLS sources do not depend on remote CORS headers.
 */
export function IptvPlayer({ channel, reloadToken }: IptvPlayerProps) {
  const channelId = channel?.id ?? null;
  const channelUrl = channel?.url ?? null;
  const channelHeaders = channel?.headers ?? EMPTY_HEADERS;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const instanceIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  if (instanceIdRef.current === null) {
    instanceIdRef.current = nextPlayerId();
  }

  useEffect(() => {
    let disposed = false;
    const generation = ++generationRef.current;
    const sessionId = `${instanceIdRef.current}:${generation}`;

    const destroyMedia = () => {
      const hls = hlsRef.current;
      hlsRef.current = null;
      if (hls) {
        try {
          hls.destroy();
        } catch {
          // A half-initialized HLS instance still needs to be disposable.
        }
      }

      const mpegts = mpegtsRef.current;
      mpegtsRef.current = null;
      if (mpegts) {
        try {
          mpegts.pause();
          mpegts.unload();
          mpegts.detachMediaElement();
          mpegts.destroy();
        } catch {
          // Treat player cleanup as best-effort during route/channel changes.
        }
      }

      const video = videoRef.current;
      if (video) {
        try {
          video.pause();
          video.removeAttribute("src");
          video.srcObject = null;
          video.load();
        } catch {
          // The element can already be detached while React is unmounting.
        }
      }
    };

    const stopProxy = async () => {
      try {
        await invokeCmd<void>("stream_proxy_stop", { sessionId });
      } catch {
        // Stop is ownership-aware; an old source can safely finish after a new one.
      }
    };

    if (!channelUrl) {
      destroyMedia();
      setStatus("idle");
      setError(null);
      void proxyQueue.enqueue(stopProxy);
      return () => {
        disposed = true;
        destroyMedia();
        void proxyQueue.enqueue(stopProxy);
      };
    }

    setStatus("connecting");
    setError(null);

    void proxyQueue
      .enqueue(async () => {
        if (disposed || generationRef.current !== generation) {
          await stopProxy();
          return;
        }

        try {
          destroyMedia();
          const hlsCandidate =
            !isMpegTransportStream(channelUrl) && !isProgressiveVideo(channelUrl);
          const localUrl = await invokeCmd<string>("stream_proxy_start", {
            url: channelUrl,
            headers: channelHeaders,
            sessionId,
            hls: hlsCandidate,
          });
          if (disposed || generationRef.current !== generation) {
            await stopProxy();
            return;
          }

          const video = videoRef.current;
          if (!video) throw new Error("播放器尚未准备好");
          const playbackUrl = `${localUrl}?t=${Date.now()}_${generation}`;
          const startPlayback = () => {
            if (disposed || generationRef.current !== generation) return;
            void video.play().then(
              () => {
                if (!disposed && generationRef.current === generation) setStatus("playing");
              },
              () => {
                if (!disposed && generationRef.current === generation) setStatus("ready");
              },
            );
          };
          const reportError = (message: string) => {
            if (disposed || generationRef.current !== generation) return;
            setStatus("error");
            setError(message);
          };

          if (isMpegTransportStream(channelUrl)) {
            const mpegts = await loadMpegts();
            if (disposed || generationRef.current !== generation) {
              await stopProxy();
              return;
            }
            if (!mpegts.isSupported()) {
              throw new Error("当前环境不支持此 MPEG-TS / FLV 频道");
            }
            const player = mpegts.createPlayer(
              {
                type: /\.flv(?:[?#]|$)/i.test(channelUrl) ? "flv" : "mpegts",
                isLive: true,
                url: playbackUrl,
                hasAudio: true,
                hasVideo: true,
              },
              {
                enableWorker: false,
                enableStashBuffer: true,
                stashInitialSize: 384,
                liveBufferLatencyChasing: true,
                liveBufferLatencyMaxLatency: 3,
                liveBufferLatencyMinRemain: 0.5,
                autoCleanupSourceBuffer: true,
              },
            );
            mpegtsRef.current = player;
            player.on(mpegts.Events.ERROR, (_type, _detail, info) => {
              const detail =
                info && typeof info === "object" && "msg" in info
                  ? String((info as { msg?: string }).msg ?? "")
                  : "";
              reportError(detail || "该频道的 MPEG-TS / FLV 流播放失败");
            });
            player.attachMediaElement(video);
            player.load();
            startPlayback();
            return;
          }

          if (isProgressiveVideo(channelUrl)) {
            video.src = playbackUrl;
            video.load();
            startPlayback();
            return;
          }

          if (Hls.isSupported()) {
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: true,
              backBufferLength: 30,
            });
            hlsRef.current = hls;
            hls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (!data.fatal) return;
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                setStatus("connecting");
                hls.startLoad();
                return;
              }
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
                return;
              }
              reportError(`该频道的 HLS 流播放失败：${data.details}`);
              try {
                hls.destroy();
              } catch {
                // A fatal parser error may already have torn down internals.
              }
            });
            hls.loadSource(playbackUrl);
            hls.attachMedia(video);
            return;
          }

          if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = playbackUrl;
            video.load();
            startPlayback();
            return;
          }
          throw new Error("当前环境不支持 HLS 频道播放");
        } catch (cause) {
          if (disposed || generationRef.current !== generation) return;
          const message =
            cause instanceof Error ? cause.message : "频道播放初始化失败，请切换线路或重试";
          setStatus("error");
          setError(message);
          destroyMedia();
          await stopProxy();
        }
      })
      .catch(() => {
        // All actionable errors are reflected in the player surface above.
      });

    return () => {
      disposed = true;
      destroyMedia();
      void proxyQueue.enqueue(stopProxy);
    };
  }, [channelHeaders, channelId, channelUrl, reloadToken]);

  const statusText: Record<PlaybackStatus, string> = {
    idle: "选择一个频道开始观看",
    connecting: "正在连接频道…",
    ready: "频道已就绪，点击播放器开始",
    playing: "正在播放",
    error: "播放失败",
  };

  return (
    <section className="relative overflow-hidden rounded-2xl border border-border-subtle bg-black shadow-sm">
      <div className="relative aspect-video min-h-56 bg-muted/20">
        <video
          ref={videoRef}
          controls
          playsInline
          className="size-full bg-black object-contain"
          aria-label={channel ? `${channel.name} 播放器` : "IPTV 播放器"}
          onPlaying={() => setStatus("playing")}
          onWaiting={() => setStatus((current) => (current === "playing" ? "connecting" : current))}
          onCanPlay={() => setStatus((current) => (current === "connecting" ? "ready" : current))}
          onError={() => {
            if (status !== "error") {
              setStatus("error");
              setError("浏览器无法解码此频道流");
            }
          }}
        />

        {!channel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Tv className="size-8" aria-hidden />
            <p className="text-sm">从右侧频道列表选择节目</p>
          </div>
        )}

        {channel && status !== "playing" && status !== "error" && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/30 text-primary-foreground">
            {status === "connecting" && <Spinner className="size-5" aria-label="正在连接" />}
            <p className="text-sm">{statusText[status]}</p>
          </div>
        )}

        {error && (
          <div className="absolute right-3 bottom-12 left-3 flex items-start gap-2 rounded-lg bg-background/90 p-3 text-sm text-foreground shadow-lg backdrop-blur">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        {channel && (
          <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2">
            <Badge
              variant="destructive"
              className="gap-1.5 bg-destructive text-destructive-foreground"
            >
              <Radio data-icon="inline-start" aria-hidden />
              直播
            </Badge>
            <span className="max-w-[18rem] truncate rounded-md bg-black/55 px-2 py-1 text-xs text-primary-foreground backdrop-blur">
              {channel.name}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
