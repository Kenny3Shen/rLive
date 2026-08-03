import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import {
  encodePcmBase64,
  joinAsrCaptionText,
  subscribeToVideoPcm,
  type AudioCaptureSubscription,
} from "./audio";
import { describeAsrModelStatus, useAsrModelStatus } from "./model";

type AsrCaptionSegment = {
  text: string;
  start_ms: number;
  end_ms: number;
};

type AsrTranscribeResponse = {
  segments: AsrCaptionSegment[];
};

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
  windowSeconds: number;
}) {
  const clientPlatform = getClientPlatform();
  const localAsrClient = clientPlatform === "desktop" || clientPlatform === "android";
  const model = useAsrModelStatus({ enabled: options.featureEnabled });
  const [captionsOn, setCaptionsOn] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const epochRef = useRef(0);
  const pendingJobRef = useRef<TranscriptionJob | null>(null);
  const workerRunningRef = useRef(false);
  const captionTimerRef = useRef<number | null>(null);
  const segmentSetterRef = useRef<((seconds: number) => void) | null>(null);

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
          const text = joinAsrCaptionText(response.segments);
          setNotice(null);
          if (!text) continue;
          setCaption(text);
          clearCaptionTimer();
          captionTimerRef.current = window.setTimeout(() => {
            setCaption(null);
            captionTimerRef.current = null;
          }, 8_000);
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
      setNotice(null);
      setCaptureError(null);
      pendingJobRef.current = null;
      epochRef.current += 1;
      clearCaptionTimer();
    }
  }, [clearCaptionTimer, model.supported, options.featureEnabled]);

  useEffect(() => {
    setCaption(null);
    setNotice(null);
    setCaptureError(null);
    pendingJobRef.current = null;
    epochRef.current += 1;
    segmentSetterRef.current = null;
    clearCaptionTimer();
  }, [clearCaptionTimer, options.mediaKey, options.sessionKey]);

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
        segmentSetterRef.current = nextSubscription.setSegmentSeconds;
        nextSubscription.setSegmentSeconds(options.windowSeconds);
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
      if (subscription && segmentSetterRef.current === subscription.setSegmentSeconds) {
        segmentSetterRef.current = null;
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
    options.windowSeconds,
    options.mediaKey,
    options.sessionKey,
    options.videoRef,
    processPendingJobs,
  ]);

  useEffect(() => {
    segmentSetterRef.current?.(options.windowSeconds);
  }, [options.windowSeconds]);

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
        setNotice(null);
        setCaptureError(null);
        pendingJobRef.current = null;
        epochRef.current += 1;
        clearCaptionTimer();
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
