import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, MessageSquareText, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import {
  createXgPlayer,
  loadXgPlayerModules,
  xgPlayerErrorMessage,
  type XgPlaybackKind,
  type XgPlayerInstance,
} from "@/features/room/player/xgPlayer";
import { formatRecordingDuration, recordingDanmakuUrl, type RecordingItem } from "./recording";
import { RecordedDanmakuCanvas } from "./RecordedDanmakuCanvas";
import { parseRecordedDanmakuSidecar, type RecordedDanmakuEntry } from "./recordedDanmaku";

function recordingPlaybackKind(protocol: RecordingItem["protocol"]): XgPlaybackKind {
  if (protocol === "hls") return "hls";
  if (protocol === "mpeg_ts") return "mpegts";
  if (protocol === "native") return "native";
  return "flv";
}

function finiteDuration(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

export function RecordingPlayer({ item, url }: { item: RecordingItem; url: string }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<XgPlayerInstance | null>(null);
  const volumeRef = useRef(80);
  const mutedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(80);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [danmakuEntries, setDanmakuEntries] = useState<RecordedDanmakuEntry[]>([]);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const playbackKind = recordingPlaybackKind(item.protocol);

  const danmakuUrlQuery = useQuery({
    queryKey: ["recording-danmaku", item.id],
    enabled: Boolean(item.include_danmaku),
    queryFn: () => recordingDanmakuUrl(item.id),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    const url = danmakuUrlQuery.data;
    if (!item.include_danmaku || !url) {
      setDanmakuEntries([]);
      return;
    }
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("弹幕轨读取失败");
        return response.text();
      })
      .then((text) => {
        if (!controller.signal.aborted) setDanmakuEntries(parseRecordedDanmakuSidecar(text));
      })
      .catch(() => {
        if (!controller.signal.aborted) setDanmakuEntries([]);
      });
    return () => controller.abort();
  }, [danmakuUrlQuery.data, item.include_danmaku]);

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const root = rootRef.current;
    if (!video || !root) return;
    const media = video;

    setLoading(true);
    setWaiting(false);
    setError(null);
    setPaused(true);
    setCurrentTime(0);
    setDuration(0);
    const kind = playbackKind;

    function syncTime() {
      setCurrentTime(media.currentTime || 0);
      setDuration(finiteDuration(media));
    }
    function onPlay() {
      setPaused(false);
      setWaiting(false);
      setLoading(false);
    }
    function onPause() {
      setPaused(true);
    }
    function onReady() {
      setLoading(false);
      setWaiting(false);
      syncTime();
    }
    function onWaiting() {
      setWaiting(true);
    }
    function onEnded() {
      setPaused(true);
      setWaiting(false);
    }
    function onNativeError() {
      if (!media.error) return;
      setError(media.error.message || "录制回放失败");
      setLoading(false);
      setWaiting(false);
    }

    video.volume = volumeRef.current / 100;
    video.muted = mutedRef.current;
    video.addEventListener("timeupdate", syncTime);
    video.addEventListener("durationchange", syncTime);
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onNativeError);

    void loadXgPlayerModules(kind)
      .then((modules) => {
        if (cancelled) return;
        const player = createXgPlayer(modules, {
          root,
          video,
          url,
          kind,
          isLive: false,
          hls: {
            hlsOpts: {
              lowLatencyMode: false,
              backBufferLength: 90,
              maxBufferLength: 90,
              manifestLoadingMaxRetry: 2,
              levelLoadingMaxRetry: 2,
              fragLoadingMaxRetry: 2,
            },
          },
          flv: {
            mediaDataSource: {
              type: "flv",
              isLive: false,
              hasAudio: true,
              hasVideo: true,
            },
            mpegtsConfig: {
              enableWorker: false,
              enableStashBuffer: true,
              lazyLoad: true,
              autoCleanupSourceBuffer: false,
            },
          },
          mpegts: {
            mediaDataSource: {
              type: "mpegts",
              isLive: false,
              hasAudio: true,
              hasVideo: true,
            },
            mpegtsConfig: {
              enableWorker: false,
              enableStashBuffer: true,
              lazyLoad: true,
              autoCleanupSourceBuffer: false,
            },
          },
        });
        playerRef.current = player;
        player.on("error", (cause) => {
          if (cancelled) return;
          setError(xgPlayerErrorMessage(cause, "录制回放失败"));
          setLoading(false);
          setWaiting(false);
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(xgPlayerErrorMessage(cause, "无法初始化录制播放器"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      video.removeEventListener("timeupdate", syncTime);
      video.removeEventListener("durationchange", syncTime);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onNativeError);
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.pause();
        player?.destroy();
      } catch {
        // The protocol plugin may already have released its MediaSource.
      }
    };
  }, [item.id, playbackKind, url]);

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (paused) {
      void Promise.resolve(player.play()).catch((cause) => {
        setError(xgPlayerErrorMessage(cause, "播放录制失败"));
      });
    } else {
      player.pause();
    }
  }, [paused]);

  const setPlayerVolume = useCallback((nextVolume: number) => {
    const video = videoRef.current;
    const clamped = Math.max(0, Math.min(100, nextVolume));
    volumeRef.current = clamped;
    mutedRef.current = clamped === 0;
    setVolume(clamped);
    setMuted(clamped === 0);
    if (video) {
      video.volume = clamped / 100;
      video.muted = clamped === 0;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    const nextMuted = !muted;
    mutedRef.current = nextMuted;
    setMuted(nextMuted);
    if (video) video.muted = nextMuted;
  }, [muted]);

  return (
    <section
      ref={stageRef}
      className="relative overflow-hidden rounded-2xl border border-border-subtle bg-black shadow-sm"
      aria-label={item.title + " 录制回放"}
      onKeyDown={(event) => {
        if (event.key !== " " || event.target !== event.currentTarget) return;
        event.preventDefault();
        togglePlayback();
      }}
      tabIndex={0}
    >
      <div ref={rootRef} className="relative aspect-video overflow-hidden bg-black">
        <video
          ref={videoRef}
          playsInline
          preload="metadata"
          className="absolute inset-0 size-full bg-black object-contain"
        />
        {danmakuEntries.length > 0 && (
          <RecordedDanmakuCanvas
            videoRef={videoRef}
            entries={danmakuEntries}
            active={danmakuVisible}
          />
        )}
        {item.include_danmaku && danmakuUrlQuery.data && (
          <Button
            type="button"
            variant={danmakuVisible ? "secondary" : "ghost"}
            size="sm"
            className="absolute top-3 right-3 z-10 bg-black/55 text-white backdrop-blur hover:bg-black/70 hover:text-white"
            aria-pressed={danmakuVisible}
            onClick={() => setDanmakuVisible((visible) => !visible)}
          >
            <MessageSquareText data-icon="inline-start" aria-hidden />
            弹幕
          </Button>
        )}
        {(loading || waiting) && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25">
            <Spinner className="text-white" aria-label={loading ? "正在加载录制" : "正在缓冲"} />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/65 px-8 text-center text-sm text-white">
            {error}
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 bg-card px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={paused ? "播放录制" : "暂停回放"}
          disabled={Boolean(error)}
          onClick={togglePlayback}
        >
          {paused ? (
            <Play className="fill-current" aria-hidden />
          ) : (
            <Pause className="fill-current" aria-hidden />
          )}
        </Button>
        <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
          {formatRecordingDuration(currentTime * 1000)}
        </span>
        <Slider
          value={currentTime}
          min={0}
          max={duration || 1}
          step={0.1}
          disabled={!duration}
          aria-label="回放进度"
          aria-valuetext={
            formatRecordingDuration(currentTime * 1000) +
            " / " +
            formatRecordingDuration(duration * 1000)
          }
          className="min-w-20 flex-1"
          onValueChange={(value) => {
            const next = Number(Array.isArray(value) ? value[0] : value);
            if (!Number.isFinite(next) || !videoRef.current) return;
            videoRef.current.currentTime = next;
            setCurrentTime(next);
          }}
        />
        <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
          {formatRecordingDuration(duration * 1000)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={muted ? "取消静音" : "静音"}
          aria-pressed={muted}
          onClick={toggleMute}
        >
          {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
        </Button>
        <Slider
          value={muted ? 0 : volume}
          min={0}
          max={100}
          step={1}
          aria-label="回放音量"
          className="w-20 max-sm:hidden"
          onValueChange={(value) => {
            setPlayerVolume(Number(Array.isArray(value) ? value[0] : value));
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="全屏回放"
          onClick={() => {
            const stage = stageRef.current;
            if (!stage) return;
            void stage.requestFullscreen().catch(() => undefined);
          }}
        >
          <Maximize2 aria-hidden />
        </Button>
      </div>
    </section>
  );
}
