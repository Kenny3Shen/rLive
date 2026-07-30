import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeCmd } from "@/shared/api/tauri";
import { createLocalPcmCapture, type LocalPcmCapture } from "./localPcmCapture";

const CAPTION_EVENT_NAME = "asr-caption";
const OUTBOUND_AUDIO_QUEUE_CAPACITY = 4;
const CAPTION_HIDE_DELAY_MS = 6_500;
const CAPTION_CLOCK_DRIFT_MS = 1_500;

type AsrModelStatus = {
  loaded: boolean;
  loading: boolean;
  bundled: boolean;
  path: string | null;
  active_session_id: string | null;
};

export type AsrModelLoadRequest = {
  command: "asr_model_load_default";
  args: Record<string, unknown>;
};

/**
 * Captions always use rLive's bundled tiny model. Keeping the decision here
 * rather than in settings makes every room and every platform follow the same
 * low-memory CPU-first path.
 */
export function selectAsrModelLoadRequest(
  model: Pick<AsrModelStatus, "loaded" | "loading" | "bundled" | "path">,
): AsrModelLoadRequest | null {
  if (model.loading) return null;
  return !model.loaded || !model.bundled ? { command: "asr_model_load_default", args: {} } : null;
}

type AsrCaptionEvent = {
  session_id: string;
  sequence: number;
  kind: "partial" | "final" | "status";
  start_ms: number;
  end_ms: number;
  text: string;
  status?: string | null;
};

type ActiveCaptionSession = {
  id: string;
  lifecycle: number;
  lastSequence: number;
  acceptsAudio: boolean;
  nextAudioStartMs: number | null;
};

type QueuedPcm = {
  sessionId: string;
  lifecycle: number;
  startMs: number;
  samples: Int16Array;
};

type MediaReady = {
  roomKey: string;
  mediaKey: number;
};

type MediaBinding = {
  roomKey: string;
  mediaKey: number;
};

export type LocalAsrCaptionState = "off" | "starting" | "active" | "error";

export type UseLocalAsrCaptionsResult = {
  enabled: boolean;
  pending: boolean;
  ready: boolean;
  state: LocalAsrCaptionState;
  caption: string | null;
  message: string | null;
  toggle: () => void;
};

type UseLocalAsrCaptionsOptions = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Route-stable identity. The hook deliberately fences old room media. */
  roomSessionKey?: string;
  /** Bumped by the web player whenever it mounts a brand-new <video>. */
  mediaKey: number;
  /** False while the player has no usable stream/error surface. */
  playbackAvailable: boolean;
  /** User presentation controls; never applied to the ASR input branch. */
  volume: number;
  muted: boolean;
};

let nextSessionNonce = 0;

function roomKeyFrom(sessionKey: string | undefined): string {
  return sessionKey?.trim() || "room";
}

function hashRoomKey(value: string): string {
  // Session IDs are sent in IPC headers. Keep them compact ASCII even when a
  // room ID contains non-ASCII characters, while retaining a deterministic
  // room component for diagnostics and cross-room fencing.
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function createCaptionSessionId(roomKey: string, mediaKey: number): string {
  nextSessionNonce = (nextSessionNonce + 1) % Number.MAX_SAFE_INTEGER;
  return [
    "asr",
    hashRoomKey(roomKey),
    Math.max(0, mediaKey).toString(36),
    Date.now().toString(36),
    nextSessionNonce.toString(36),
  ].join("-");
}

function messageFromError(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function isCaptionEvent(value: unknown): value is AsrCaptionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AsrCaptionEvent>;
  return (
    typeof event.session_id === "string" &&
    typeof event.sequence === "number" &&
    Number.isFinite(event.sequence) &&
    (event.kind === "partial" || event.kind === "final" || event.kind === "status") &&
    typeof event.text === "string"
  );
}

/**
 * Derive a backend-safe media-relative audio timestamp. Media elements can
 * briefly report NaN while MSE is replacing a source; never serialize that
 * value into the raw IPC header.
 */
export function nextCaptionAudioStartMs(
  previousStartMs: number | null,
  mediaCurrentTimeSeconds: number,
  durationMs: number,
): number {
  const observedEndMs =
    Number.isFinite(mediaCurrentTimeSeconds) && mediaCurrentTimeSeconds >= 0
      ? Math.round(mediaCurrentTimeSeconds * 1_000)
      : null;
  if (previousStartMs === null) {
    return observedEndMs === null ? 0 : Math.max(0, observedEndMs - durationMs);
  }
  if (
    observedEndMs !== null &&
    Math.abs(observedEndMs - (previousStartMs + durationMs)) > CAPTION_CLOCK_DRIFT_MS
  ) {
    return Math.max(0, observedEndMs - durationMs);
  }
  return previousStartMs;
}

/**
 * Room-scoped, opt-in local Whisper bridge.
 *
 * A native command owns one active ASR session, but React can temporarily
 * retain an old PlayerPane during route/media changes. The session ID and
 * lifecycle token therefore fence both Tauri events and raw audio IPC here
 * before any caption can reach the overlay.
 */
export function useLocalAsrCaptions({
  videoRef,
  roomSessionKey,
  mediaKey,
  playbackAvailable,
  volume,
  muted,
}: UseLocalAsrCaptionsOptions): UseLocalAsrCaptionsResult {
  const roomKey = roomKeyFrom(roomSessionKey);
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<LocalAsrCaptionState>("off");
  const [caption, setCaption] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mediaReady, setMediaReady] = useState<MediaReady | null>(null);

  const graphRef = useRef<(LocalPcmCapture & { mediaKey: number }) | null>(null);
  const activeSessionRef = useRef<ActiveCaptionSession | null>(null);
  const sessionLifecycleRef = useRef(0);
  const enableAttemptRef = useRef(0);
  const presentationRef = useRef({ volume, muted });
  const outboundRef = useRef<{ queue: QueuedPcm[]; sending: boolean }>({
    queue: [],
    sending: false,
  });
  const mediaBindingRef = useRef<MediaBinding>({ roomKey, mediaKey });
  const captionClearTimerRef = useRef<number | null>(null);

  // A route can change before useWebPlayer has replaced its video node. Keep
  // the old media key bound to its old room, so a late `playing` event from the
  // tearing-down stream can never make the next room look ready.
  if (mediaBindingRef.current.mediaKey !== mediaKey) {
    mediaBindingRef.current = { roomKey, mediaKey };
  }
  presentationRef.current = { volume, muted };
  const mediaBelongsToCurrentRoom = mediaBindingRef.current.roomKey === roomKey;
  const ready =
    playbackAvailable &&
    mediaBelongsToCurrentRoom &&
    mediaReady?.roomKey === roomKey &&
    mediaReady.mediaKey === mediaKey;

  const clearCaption = useCallback(() => {
    if (captionClearTimerRef.current !== null) {
      window.clearTimeout(captionClearTimerRef.current);
      captionClearTimerRef.current = null;
    }
    setCaption(null);
  }, []);

  const clearOutboundForSession = useCallback((sessionId: string) => {
    const outbound = outboundRef.current;
    outbound.queue = outbound.queue.filter((item) => item.sessionId !== sessionId);
  }, []);

  const reportAudioPushFailure = useCallback((sessionId: string, lifecycle: number) => {
    const active = activeSessionRef.current;
    if (!active || active.id !== sessionId || active.lifecycle !== lifecycle) return;
    // Keep the session alive: a transient bridge failure should not tear down
    // an otherwise healthy stream. The native bounded queue still protects CPU
    // and memory when it recovers.
    setMessage("本地字幕音频传输暂时失败，正在继续尝试");
  }, []);

  const pumpOutboundAudio = useCallback(() => {
    const outbound = outboundRef.current;
    if (outbound.sending) return;
    outbound.sending = true;

    const pump = () => {
      const next = outbound.queue.shift();
      if (!next) {
        outbound.sending = false;
        return;
      }

      const active = activeSessionRef.current;
      if (!active || active.id !== next.sessionId || active.lifecycle !== next.lifecycle) {
        pump();
        return;
      }

      // This deliberately bypasses invokeCmd: Uint8Array becomes Tauri's raw
      // body rather than a JSON sample array. The header names match the Rust
      // `tauri::ipc::Request` command contract.
      const rawPcm = new Uint8Array(
        next.samples.buffer,
        next.samples.byteOffset,
        next.samples.byteLength,
      );
      void invoke("asr_audio_push", rawPcm, {
        headers: {
          "x-rlive-asr-session": next.sessionId,
          "x-rlive-asr-start-ms": String(next.startMs),
        },
      }).then(
        () => pump(),
        () => {
          reportAudioPushFailure(next.sessionId, next.lifecycle);
          pump();
        },
      );
    };

    pump();
  }, [reportAudioPushFailure]);

  const enqueuePcm = useCallback(
    (samples: Int16Array) => {
      const active = activeSessionRef.current;
      const graph = graphRef.current;
      if (!active?.acceptsAudio || !graph || samples.length === 0) return;

      const durationMs = Math.round((samples.length * 1_000) / 16_000);
      const startMs = nextCaptionAudioStartMs(
        active.nextAudioStartMs,
        graph.video.currentTime,
        durationMs,
      );
      active.nextAudioStartMs = startMs + durationMs;

      const outbound = outboundRef.current;
      while (outbound.queue.length >= OUTBOUND_AUDIO_QUEUE_CAPACITY) {
        // Fresh audio is more useful than delayed speech for live captions.
        outbound.queue.shift();
      }
      outbound.queue.push({
        sessionId: active.id,
        lifecycle: active.lifecycle,
        startMs,
        samples,
      });
      pumpOutboundAudio();
    },
    [pumpOutboundAudio],
  );

  const ensureGraph = useCallback((): LocalPcmCapture & {
    mediaKey: number;
  } => {
    const video = videoRef.current;
    if (!video) throw new Error("播放器尚未准备好，无法开启本地字幕");

    const current = graphRef.current;
    if (current?.mediaKey === mediaKey && current.video === video) return current;

    // A graph only changes alongside useWebPlayer's keyed video replacement.
    // Disposing a graph for a still-mounted video would make it impossible to
    // create another MediaElementAudioSourceNode for that element later.
    if (current) {
      current.dispose();
      graphRef.current = null;
    }

    const graph = Object.assign(createLocalPcmCapture({ video, onPcm: enqueuePcm }), { mediaKey });
    graph.setPresentationLevel(presentationRef.current.volume, presentationRef.current.muted);
    graphRef.current = graph;
    return graph;
  }, [enqueuePcm, mediaKey, videoRef]);

  // Keep every player volume/mute action on the primary GainNode. The hook is
  // declared after useWebPlayer in PlayerPane, so this effect restores unity
  // media-element gain after the player's own DOM-sync effect has run.
  useEffect(() => {
    graphRef.current?.setPresentationLevel(volume, muted);
  }, [muted, volume]);

  // Dispose only after a fresh keyed <video> is mounted (or on final unmount),
  // never merely because roomSessionKey changes while useWebPlayer is still
  // asynchronously tearing down its old MSE source.
  useEffect(
    () => () => {
      const graph = graphRef.current;
      if (!graph || graph.mediaKey !== mediaKey) return;
      graph.dispose();
      graphRef.current = null;
    },
    [mediaKey],
  );

  // Bind readiness to an actual `playing` event from the media node owned by
  // this room. This is stricter than useWebPlayer's `running` boolean during
  // route transitions, when that boolean can still describe the old stream.
  useEffect(() => {
    if (!mediaBelongsToCurrentRoom) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    const markReady = () => {
      const binding = mediaBindingRef.current;
      if (
        cancelled ||
        binding.mediaKey !== mediaKey ||
        binding.roomKey !== roomKey ||
        videoRef.current !== video
      ) {
        return;
      }
      setMediaReady({ roomKey, mediaKey });
    };
    video.addEventListener("playing", markReady);
    if (!video.paused && video.readyState >= 2) markReady();
    return () => {
      cancelled = true;
      video.removeEventListener("playing", markReady);
    };
  }, [mediaBelongsToCurrentRoom, mediaKey, roomKey, videoRef]);

  useEffect(() => {
    if (!mediaBelongsToCurrentRoom) setMediaReady(null);
  }, [mediaBelongsToCurrentRoom]);

  // One event listener is enough for this room component. It is deliberately
  // local rather than global: unmounting PlayerPane must immediately reject
  // captions from an old native worker session.
  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | null = null;
    void listen<unknown>(CAPTION_EVENT_NAME, (event) => {
      if (!alive || !isCaptionEvent(event.payload)) return;
      const payload = event.payload;
      const active = activeSessionRef.current;
      if (!active || payload.session_id !== active.id || payload.sequence <= active.lastSequence) {
        return;
      }
      active.lastSequence = payload.sequence;

      if (payload.kind === "status") {
        if (payload.status === "started") {
          setState("active");
          setMessage(null);
        } else if (payload.status === "recognition_error") {
          setState("active");
          setMessage("本地字幕识别暂时失败，下一段语音会自动重试");
        } else if (payload.status === "model_unloaded" || payload.status === "model_loading") {
          activeSessionRef.current = null;
          clearOutboundForSession(payload.session_id);
          setEnabled(false);
          clearCaption();
          setState("error");
          setMessage("本地字幕模型已变更，请在设置－播放中重新加载后再开启");
        }
        return;
      }

      const text = payload.text.trim();
      if (!text) return;
      setCaption(text);
      setState("active");
      setMessage(null);
      if (captionClearTimerRef.current !== null) {
        window.clearTimeout(captionClearTimerRef.current);
      }
      captionClearTimerRef.current = window.setTimeout(() => {
        captionClearTimerRef.current = null;
        setCaption(null);
      }, CAPTION_HIDE_DELAY_MS);
    }).then(
      (nextUnlisten) => {
        if (!alive) {
          void nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      },
      () => {
        if (!alive) return;
        setMessage("本地字幕事件连接失败，请重新开启字幕");
      },
    );
    return () => {
      alive = false;
      if (unlisten) void unlisten();
    };
  }, [clearCaption, clearOutboundForSession]);

  // Start one native session only after the corresponding fresh media node
  // actually plays. Every cleanup stops only its own ID; Rust treats a stale
  // stop as a no-op if the next room has already claimed the worker.
  useEffect(() => {
    if (!enabled || !ready) {
      if (!enabled) {
        setState("off");
        clearCaption();
      } else {
        setState("starting");
      }
      return;
    }

    let cancelled = false;
    const lifecycle = ++sessionLifecycleRef.current;
    const sessionId = createCaptionSessionId(roomKey, mediaKey);
    let graph: (LocalPcmCapture & { mediaKey: number }) | null = null;
    activeSessionRef.current = {
      id: sessionId,
      lifecycle,
      lastSequence: 0,
      acceptsAudio: false,
      nextAudioStartMs: null,
    };
    clearCaption();
    setState("starting");
    setMessage(null);

    void (async () => {
      try {
        graph = ensureGraph();
        // The normal toggle calls resume in the click handler. This repeat is
        // useful after a reconnect/new video where Chromium permits the prior
        // user activation to resume its replacement context.
        await graph.resume();
        if (cancelled) return;

        const model = await invokeCmd<AsrModelStatus>("asr_status");
        if (!model.loaded || model.loading) {
          throw new Error("请先在设置－播放中加载本地 Whisper 模型");
        }
        if (cancelled) return;

        await invokeCmd("asr_session_start", { sessionId });
        if (cancelled) {
          void invokeCmd("asr_session_stop", { sessionId }).catch(() => {});
          return;
        }
        await graph.setCapturing(true);
        const active = activeSessionRef.current;
        if (cancelled || !active || active.id !== sessionId || active.lifecycle !== lifecycle) {
          void graph.setCapturing(false);
          void invokeCmd("asr_session_stop", { sessionId }).catch(() => {});
          return;
        }
        active.acceptsAudio = true;
        setState("active");
      } catch (error) {
        void graph?.setCapturing(false);
        const active = activeSessionRef.current;
        if (cancelled || !active || active.id !== sessionId || active.lifecycle !== lifecycle) {
          return;
        }
        activeSessionRef.current = null;
        clearOutboundForSession(sessionId);
        setEnabled(false);
        clearCaption();
        setState("error");
        setMessage(messageFromError(error, "无法开启本地字幕"));
        void invokeCmd("asr_session_stop", { sessionId }).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      const active = activeSessionRef.current;
      if (active?.id === sessionId && active.lifecycle === lifecycle) {
        activeSessionRef.current = null;
      }
      clearOutboundForSession(sessionId);
      void graph?.setCapturing(false);
      void invokeCmd("asr_session_stop", { sessionId }).catch(() => {});
    };
  }, [clearCaption, clearOutboundForSession, enabled, ensureGraph, mediaKey, ready, roomKey]);

  useEffect(
    () => () => {
      if (captionClearTimerRef.current !== null) {
        window.clearTimeout(captionClearTimerRef.current);
      }
      const active = activeSessionRef.current;
      activeSessionRef.current = null;
      if (active) {
        clearOutboundForSession(active.id);
        void invokeCmd("asr_session_stop", { sessionId: active.id }).catch(() => {});
      }
    },
    [clearOutboundForSession],
  );

  const toggle = useCallback(() => {
    if (pending) return;
    if (enabled) {
      enableAttemptRef.current += 1;
      setEnabled(false);
      setState("off");
      setMessage(null);
      clearCaption();
      return;
    }
    if (!ready) {
      setState("error");
      setMessage("播放器音频尚未就绪，请等待直播开始后再开启本地字幕");
      return;
    }

    let graph: (LocalPcmCapture & { mediaKey: number }) | null = null;
    try {
      graph = ensureGraph();
      graph.setPresentationLevel(volume, muted);
      // Start resume while this click is still a trusted user gesture. The
      // session effect awaits the same context before connecting the worklet.
      void graph.resume().catch(() => {
        // The effect produces a user-facing error only if the browser still
        // refuses to resume when it begins the native session.
      });
    } catch (error) {
      setState("error");
      setMessage(messageFromError(error, "无法初始化本地字幕音频捕获"));
      return;
    }

    const attempt = ++enableAttemptRef.current;
    setPending(true);
    setState("starting");
    setMessage(null);
    void (async () => {
      const model = await invokeCmd<AsrModelStatus>("asr_status");
      if (model.loading) {
        throw new Error("本地字幕模型正在加载，请稍候");
      }
      const request = selectAsrModelLoadRequest(model);
      return request ? invokeCmd<AsrModelStatus>(request.command, request.args) : model;
    })().then(
      (model) => {
        if (attempt !== enableAttemptRef.current) return;
        setPending(false);
        if (!model.loaded || model.loading) {
          setState("error");
          setMessage("本地字幕模型尚未就绪，请稍后重试");
          return;
        }
        setEnabled(true);
      },
      (error) => {
        if (attempt !== enableAttemptRef.current) return;
        setPending(false);
        setState("error");
        setMessage(messageFromError(error, "无法检查本地字幕模型状态"));
      },
    );
  }, [clearCaption, enabled, ensureGraph, muted, pending, ready, volume]);

  return { enabled, pending, ready, state, caption, message, toggle };
}
