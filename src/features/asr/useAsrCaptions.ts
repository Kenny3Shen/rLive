import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import {
  appendAsrCaptionLine,
  encodePcmBase64,
  formatAsrCaptionSegment,
  subscribeToVideoPcm,
  type AudioCaptureSubscription,
} from "./audio";
import { describeAsrModelStatus, useAsrModelStatus } from "./model";

type AsrCaptionSegment = {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker_id: number | null;
};

type AsrTranscribeResponse = {
  /** Endpointed utterances, safe to append to the committed line. */
  segments: AsrCaptionSegment[];
  /** Current in-flight hypothesis; replaced on every window. */
  partial: string | null;
};

/** Committed captions older than this are dropped from the visible line. */
const CAPTION_RETENTION_MS = 12_000;
type TranscriptionJob = {
  pcm: Float32Array;
  epoch: number;
};

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function useAsrCaptions(options: {
  videoRef: RefObject<HTMLVideoElement | null>;
  mediaKey: number;
  sessionKey: string;
  featureEnabled: boolean;
  settingPending: boolean;
  mediaAvailable: boolean;
  chunkSeconds: number;
}) {
  const clientPlatform = getClientPlatform();
  const localAsrClient = clientPlatform === "desktop" || clientPlatform === "android";
  const model = useAsrModelStatus({ enabled: options.featureEnabled });
  const [captionsOn, setCaptionsOn] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const epochRef = useRef(0);
  const pendingJobRef = useRef<TranscriptionJob | null>(null);
  const workerRunningRef = useRef(false);
  const captionTimerRef = useRef<number | null>(null);
  const chunkSetterRef = useRef<((seconds: number) => void) | null>(null);

  const clearCaptionTimer = useCallback(() => {
    if (captionTimerRef.current !== null) {
      window.clearTimeout(captionTimerRef.current);
      captionTimerRef.current = null;
    }
  }, []);

  const processPendingJobs = useCallback(async () => {
    if (workerRunningRef.current) return;
    workerRunningRef.current = true;
    setProcessing(true);
    try {
      while (pendingJobRef.current) {
        const job = pendingJobRef.current;
        pendingJobRef.current = null;
        try {
          const response = await invokeCmd<AsrTranscribeResponse>("asr_transcribe", {
            pcmBase64: encodePcmBase64(job.pcm),
          });
          if (job.epoch !== epochRef.current) continue;
          setNotice(null);

          // The live hypothesis changes on every window, including back to
          // empty once an utterance is committed.
          setPartial(response.partial?.trim() || null);

          if (response.segments.length === 0) continue;
          setCaption((current) =>
            response.segments.reduce(
              (committed, segment) =>
                appendAsrCaptionLine(committed || null, formatAsrCaptionSegment(segment)),
              current ?? "",
            ),
          );
          // Only the committed line expires; the partial is superseded by the
          // next window rather than timed out.
          clearCaptionTimer();
          captionTimerRef.current = window.setTimeout(() => {
            setCaption(null);
            captionTimerRef.current = null;
          }, CAPTION_RETENTION_MS);
        } catch (error) {
          if (job.epoch !== epochRef.current) continue;
          setNotice(`语音识别失败：${errorMessage(error)}`);
        }
      }
    } finally {
      workerRunningRef.current = false;
      setProcessing(false);
      if (pendingJobRef.current) void processPendingJobs();
    }
  }, [clearCaptionTimer]);

  useEffect(() => {
    if (!options.featureEnabled || !model.supported) {
      setCaptionsOn(false);
      setCaption(null);
      setPartial(null);
      setNotice(null);
      setCaptureError(null);
      pendingJobRef.current = null;
      epochRef.current += 1;
      clearCaptionTimer();
    }
  }, [clearCaptionTimer, model.supported, options.featureEnabled]);

  useEffect(() => {
    setCaption(null);
    setPartial(null);
    setNotice(null);
    setCaptureError(null);
    pendingJobRef.current = null;
    epochRef.current += 1;
    chunkSetterRef.current = null;
    clearCaptionTimer();
    // Streaming decode keeps state across windows, so a new room or media
    // element must clear it or the next caption resumes mid-utterance.
    if (model.supported) void invokeCmd("asr_reset_stream").catch(() => {});
  }, [clearCaptionTimer, model.supported, options.mediaKey, options.sessionKey]);

  useEffect(() => {
    if (
      !captionsOn ||
      !options.featureEnabled ||
      !model.supported ||
      model.status?.state !== "ready" ||
      !options.mediaAvailable
    ) {
      return;
    }
    const video = options.videoRef.current;
    if (!video) return;

    const epoch = ++epochRef.current;
    let cancelled = false;
    let subscription: AudioCaptureSubscription | null = null;
    void subscribeToVideoPcm(video, (pcm) => {
      // Publish each completed window immediately, while keeping only the
      // newest not-yet-started window when inference is slower than playback.
      pendingJobRef.current = { pcm, epoch };
      void processPendingJobs();
    })
      .then((nextSubscription) => {
        if (cancelled) {
          nextSubscription.release();
          return;
        }
        subscription = nextSubscription;
        chunkSetterRef.current = nextSubscription.setChunkSeconds;
        nextSubscription.setChunkSeconds(options.chunkSeconds);
        setCaptureError(null);
      })
      .catch((error) => {
        if (cancelled || epoch !== epochRef.current) return;
        const message = errorMessage(error);
        setCaptureError(message);
        setNotice(`无法开启语音字幕：${message}`);
        setCaptionsOn(false);
      });

    return () => {
      cancelled = true;
      subscription?.release();
      if (subscription && chunkSetterRef.current === subscription.setChunkSeconds) {
        chunkSetterRef.current = null;
      }
      if (epoch === epochRef.current) epochRef.current += 1;
      pendingJobRef.current = null;
    };
  }, [
    captionsOn,
    model.status?.state,
    model.supported,
    options.featureEnabled,
    options.mediaAvailable,
    options.chunkSeconds,
    options.mediaKey,
    options.sessionKey,
    options.videoRef,
    processPendingJobs,
  ]);

  useEffect(() => {
    chunkSetterRef.current?.(options.chunkSeconds);
  }, [options.chunkSeconds]);

  useEffect(() => () => clearCaptionTimer(), [clearCaptionTimer]);

  const toggle = useCallback(() => {
    if (!localAsrClient || !model.supported || !options.featureEnabled) return;
    if (model.status?.state === "error" || model.queryError) {
      setNotice(null);
      setCaptureError(null);
      void model.prepare().catch((error) => {
        setNotice(`模型准备失败：${errorMessage(error)}`);
      });
      return;
    }
    if (model.status?.state !== "ready" || !options.mediaAvailable) return;

    setCaptionsOn((current) => {
      const next = !current;
      if (next) {
        setNotice(null);
        setCaptureError(null);
      } else {
        setCaption(null);
        setPartial(null);
        setNotice(null);
        setCaptureError(null);
        pendingJobRef.current = null;
        epochRef.current += 1;
        clearCaptionTimer();
        void invokeCmd("asr_reset_stream").catch(() => {});
      }
      return next;
    });
  }, [clearCaptionTimer, localAsrClient, model, options.featureEnabled, options.mediaAvailable]);

  const statusPresentation = describeAsrModelStatus(model.status, {
    enabled: options.featureEnabled,
    supported: model.supported,
    queryError: model.queryError,
  });

  let controlLabel = captionsOn ? "关闭语音字幕" : "开启语音字幕";
  let controlDisabled = false;
  // Recognition continues after enabling captions. A spinner for every
  // window makes the captions icon flash, so busy only describes preparation.
  let controlBusy = false;
  if (!isTauri() || !localAsrClient) {
    controlLabel = "语音字幕仅在 Tauri 桌面或 Android 客户端可用";
    controlDisabled = true;
  } else if (!options.featureEnabled) {
    controlLabel = "请先在设置中启用语音字幕";
    controlDisabled = true;
  } else if (options.settingPending) {
    controlLabel = "正在同步语音字幕设置";
    controlDisabled = true;
    controlBusy = true;
  } else if (model.status?.state === "error" || model.queryError || captureError) {
    controlLabel = captureError ? "重试开启语音字幕" : "重试准备语音字幕模型";
  } else if (model.status?.state !== "ready") {
    controlLabel = statusPresentation.message;
    controlDisabled = true;
    controlBusy = statusPresentation.busy;
  } else if (!options.mediaAvailable) {
    controlLabel = "当前没有可识别的直播音频";
    controlDisabled = true;
  }

  return {
    desktopClient: localAsrClient,
    captionsOn,
    caption,
    partial,
    notice,
    noticeIsError: notice !== null,
    processing,
    modelStatus: model.status,
    modelQueryError: model.queryError,
    controlLabel,
    controlDisabled,
    controlBusy,
    toggle,
  };
}
