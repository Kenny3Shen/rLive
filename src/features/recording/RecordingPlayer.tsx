import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, MessageSquareText, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import {
  createXgPlayer,
  loadXgPlayerModules,
  xgPlayerErrorMessage,
  type XgPlaybackKind,
  type XgPlayerInstance,
} from "@/features/room/player/xgPlayer";
import {
  clampRecordingPlaybackTime,
  formatRecordingDuration,
  recordingDanmakuUrl,
  type RecordingItem,
} from "./recording";
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

const RECORDING_SEEK_TIMEOUT_MS = 8_000;
const RECORDING_SEEK_TOLERANCE_SECONDS = 1.5;
const RECORDING_MPEGTS_CONFIG = {
  enableWorker: false,
  enableStashBuffer: true,
  lazyLoad: true,
  autoCleanupSourceBuffer: false,
  seekType: "range",
  rangeLoadZeroStart: true,
  accurateSeek: false,
};

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
  const [playerRevision, setPlayerRevision] = useState(0);
  const sliderTargetRef = useRef<number | null>(null);
  const seekTargetRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  const recoverySeekRef = useRef<number | null>(null);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekRequestRef = useRef(0);
  const playbackKind = recordingPlaybackKind(item.protocol);
  const recordedDuration = Math.max(0, item.duration_ms / 1000);

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

  const clearSeekTimer = useCallback(() => {
    if (seekTimerRef.current !== null) {
      clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    }
  }, []);

  const completeSeek = useCallback(() => {
    seekTargetRef.current = null;
    clearSeekTimer();
    setWaiting(false);
  }, [clearSeekTimer]);

  const seekTo = useCallback(
    (requestedTarget: number, allowRecovery = true) => {
      const media = videoRef.current;
      if (!media || !Number.isFinite(requestedTarget)) return;

      const availableDuration = recordedDuration > 0 ? recordedDuration : duration;
      const target = Math.max(
        0,
        Math.min(requestedTarget, availableDuration > 0 ? availableDuration : requestedTarget),
      );
      const request = ++seekRequestRef.current;
      endedRef.current = false;
      sliderTargetRef.current = null;
      seekTargetRef.current = target;
      clearSeekTimer();
      setCurrentTime(target);
      setError(null);
      setWaiting(true);

      // The progress bar can be used before mpegts.js has attached its seek
      // handler. Preserve that target until the protocol player is ready.
      if (!playerRef.current && playbackKind !== "native") {
        recoverySeekRef.current = target;
        return;
      }

      try {
        media.currentTime = target;
      } catch {
        seekTargetRef.current = null;
        setWaiting(false);
        setError("跳转失败，请重试");
        return;
      }

      seekTimerRef.current = setTimeout(() => {
        if (seekRequestRef.current !== request) return;
        const failedTarget = seekTargetRef.current;
        seekTargetRef.current = null;
        seekTimerRef.current = null;
        setWaiting(false);
        if (allowRecovery && failedTarget !== null && playbackKind !== "native") {
          recoverySeekRef.current = failedTarget;
          setLoading(true);
          setPlayerRevision((revision) => revision + 1);
        } else {
          setError("跳转失败，请重试");
        }
      }, RECORDING_SEEK_TIMEOUT_MS);
    },
    [clearSeekTimer, duration, playbackKind, recordedDuration],
  );

  const seekToRef = useRef(seekTo);
  seekToRef.current = seekTo;

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
    setDuration(recordedDuration);
    endedRef.current = false;
    const kind = playbackKind;

    function syncTime() {
      if (cancelled) return;
      const actualTime = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
      // Recorder metadata is authoritative. An FLV MediaSource can expose a
      // transient duration of 0 or 1 second while its buffer is being rebuilt.
      const nextDuration = recordedDuration > 0 ? recordedDuration : finiteDuration(media);
      setCurrentTime((previousTime) =>
        clampRecordingPlaybackTime(
          sliderTargetRef.current !== null || endedRef.current ? previousTime : actualTime,
          nextDuration,
        ),
      );
      setDuration((previousDuration) =>
        endedRef.current && nextDuration <= 0 ? previousDuration : nextDuration,
      );
      const target = seekTargetRef.current;
      const targetIsEnd =
        target !== null &&
        nextDuration > 0 &&
        Math.abs(target - nextDuration) <= RECORDING_SEEK_TOLERANCE_SECONDS;
      if (
        target !== null &&
        (Math.abs(actualTime - target) <= RECORDING_SEEK_TOLERANCE_SECONDS ||
          (media.ended && targetIsEnd))
      ) {
        completeSeek();
      }
    }
    function onPlay() {
      if (cancelled) return;
      endedRef.current = false;
      setPaused(false);
      setWaiting(false);
      setLoading(false);
    }
    function onPause() {
      if (cancelled) return;
      setPaused(true);
    }
    function onReady() {
      if (cancelled) return;
      setLoading(false);
      if (seekTargetRef.current === null) setWaiting(false);
      syncTime();
      const pendingTarget = recoverySeekRef.current;
      if (pendingTarget !== null) {
        recoverySeekRef.current = null;
        setTimeout(() => {
          if (!cancelled) seekToRef.current(pendingTarget, false);
        }, 0);
      }
    }
    function onWaiting() {
      if (cancelled || endedRef.current || media.ended) return;
      setWaiting(true);
    }
    function onEnded() {
      // A queued `ended` event can arrive after replay or seek has already
      // cleared the media's terminal state. Ignore that stale event.
      if (cancelled || !media.ended) return;
      const endDuration =
        recordedDuration > 0
          ? recordedDuration
          : finiteDuration(media) || clampRecordingPlaybackTime(media.currentTime, 0);
      const target = seekTargetRef.current;
      if (
        target !== null &&
        (endDuration <= 0 || Math.abs(target - endDuration) > RECORDING_SEEK_TOLERANCE_SECONDS)
      ) {
        return;
      }
      endedRef.current = true;
      setDuration(endDuration);
      setCurrentTime(endDuration);
      setPaused(true);
      if (seekTargetRef.current === null) setWaiting(false);
      else completeSeek();
    }
    function onSeeking() {
      if (cancelled) return;
      if (seekTargetRef.current !== null) setWaiting(true);
    }
    function onSeeked() {
      if (!cancelled && seekTargetRef.current !== null) syncTime();
    }
    function onNativeError() {
      if (cancelled) return;
      if (!media.error) return;
      seekTargetRef.current = null;
      clearSeekTimer();
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
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
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
              ...RECORDING_MPEGTS_CONFIG,
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
              ...RECORDING_MPEGTS_CONFIG,
            },
          },
        });
        playerRef.current = player;
        player.on("error", (cause) => {
          if (cancelled) return;
          seekTargetRef.current = null;
          clearSeekTimer();
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
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onNativeError);
      seekRequestRef.current += 1;
      clearSeekTimer();
      seekTargetRef.current = null;
      sliderTargetRef.current = null;
      endedRef.current = false;
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.pause();
        player?.destroy();
      } catch {
        // The protocol plugin may already have released its MediaSource.
      }
    };
  }, [clearSeekTimer, completeSeek, item.id, playbackKind, playerRevision, recordedDuration, url]);

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
          <div className="absolute inset-0 flex items-center justify-center break-all bg-black/65 px-8 text-center text-sm text-white">
            {error}
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 overflow-hidden bg-card px-2 py-1.5">
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
          className="!w-auto min-w-0 flex-1"
          onValueChange={(value) => {
            const next = Number(Array.isArray(value) ? value[0] : value);
            if (!Number.isFinite(next)) return;
            sliderTargetRef.current = next;
            setCurrentTime(next);
          }}
          onValueCommitted={(value) => {
            const next = Number(Array.isArray(value) ? value[0] : value);
            if (Number.isFinite(next)) seekTo(next);
          }}
        />
        <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
          {formatRecordingDuration(duration * 1000)}
        </span>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={muted ? "调节音量（当前静音）" : `调节音量（当前 ${volume}%）`}
              />
            }
          >
            {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
          </PopoverTrigger>
          <PopoverContent
            container={stageRef}
            side="top"
            align="end"
            className="w-auto items-center gap-2 p-2.5"
          >
            <PopoverTitle className="sr-only">回放音量</PopoverTitle>
            <Slider
              orientation="vertical"
              value={muted ? 0 : volume}
              min={0}
              max={100}
              step={1}
              aria-label="回放音量"
              aria-valuetext={`${Math.round(muted ? 0 : volume)}%`}
              className="h-28"
              onValueChange={(value) => {
                setPlayerVolume(Number(Array.isArray(value) ? value[0] : value));
              }}
            />
            <Separator className="w-8" />
            <Button
              type="button"
              variant={muted ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={muted ? "取消静音" : "静音"}
              aria-pressed={muted}
              onClick={toggleMute}
            >
              <VolumeX aria-hidden />
            </Button>
          </PopoverContent>
        </Popover>
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
