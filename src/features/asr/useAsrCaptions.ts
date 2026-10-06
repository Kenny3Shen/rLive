import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
} from "@/shared/types/live";
import {
  appendAsrCaptionLine,
  encodePcmBase64,
  formatAsrCaptionSegment,
  subscribeToVideoPcm,
  type AudioCaptureSubscription,
} from "./audio";
import { describeAsrModelStatus, useAsrModelStatus, type AsrModelStatus } from "./model";
import { useCaptionTranslation } from "./useCaptionTranslation";

type AsrCaptionSegment = {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker_id: number | null;
};

type AsrTranscribeResponse = {
  /** 已被端点定稿的语句，可以安全地追加到已提交行之后。 */
  segments: AsrCaptionSegment[];
  /** 当前在途的假设文本；每个窗口都会替换。 */
  partial: string | null;
};

/** 早于此时长的已提交字幕会从可见行中移除。 */
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

export type AsrCaptionsOptions = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 媒体元素换代计数：递增即视为新的采集会话。 */
  mediaKey: number;
  /** 会话身份（房间 / 频道 / 稿件）：变化时清空流式解码状态。 */
  sessionKey: string;
  featureEnabled: boolean;
  settingPending: boolean;
  mediaAvailable: boolean;
  chunkSeconds: number;
  translationEnabled: boolean;
  translationFrom: CaptionTranslationSourceLanguage;
  translationTo: CaptionTranslationLanguage;
};

/** 一条 ASR 管线对播放页的完整契约：叠加层内容 + 控件呈现 + 开关。 */
export type AsrCaptions = {
  /** 本机是否具备本地 ASR 客户端形态（桌面）。 */
  desktopClient: boolean;
  captionsOn: boolean;
  /** 已定稿的可见行。 */
  caption: string | null;
  translatedCaption: string | null;
  /** 在途假设文本，每个窗口替换。 */
  partial: string | null;
  notice: string | null;
  translationNotice: string | null;
  translationPending: boolean;
  noticeIsError: boolean;
  processing: boolean;
  modelStatus: AsrModelStatus | null;
  modelQueryError: string | null;
  controlLabel: string;
  controlDisabled: boolean;
  controlBusy: boolean;
  toggle: () => void;
};

export function useAsrCaptions(options: AsrCaptionsOptions): AsrCaptions {
  const clientPlatform = getClientPlatform();
  const localAsrClient = clientPlatform === "desktop";
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
  /** 用户已表达「要开字幕」，但会话还在加载；就绪后自动开启。 */
  const pendingEnableRef = useRef(false);
  const translation = useCaptionTranslation({
    active: captionsOn,
    enabled: options.translationEnabled,
    from: options.translationFrom,
    to: options.translationTo,
    mediaKey: options.mediaKey,
    sessionKey: options.sessionKey,
  });
  const enqueueTranslation = translation.enqueue;

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

          // 实时假设随每个窗口变化，包括语句被提交后回到空值。
          setPartial(response.partial?.trim() || null);

          if (response.segments.length === 0) continue;
          enqueueTranslation(response.segments);
          setCaption((current) =>
            response.segments.reduce(
              (committed, segment) =>
                appendAsrCaptionLine(committed || null, formatAsrCaptionSegment(segment)),
              current ?? "",
            ),
          );
          // 只有已提交行会过期；部分文本由下一个窗口取代，而不是超时清除。
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
  }, [clearCaptionTimer, enqueueTranslation]);

  // 会话加载完成后兑现用户已经表达过的「开字幕」意图。
  // 只在这里消费一次：用户如果又点了一下关闭，pendingEnableRef 会先被清掉。
  useEffect(() => {
    if (!pendingEnableRef.current) return;
    if (model.status?.state !== "ready" || !options.mediaAvailable) return;
    pendingEnableRef.current = false;
    // oxlint-disable-next-line react/set-state-in-effect
    setCaptionsOn(true);
  }, [model.status?.state, options.mediaAvailable]);

  // 字幕还开着但会话被空闲看门狗释放：重新加载，否则开关显示为开启、
  // 实际却没有采集，直到用户重新点一次。只在媒体可用时重载 ——
  // 媒体不可用时采集本来就不会启动，重载只会陷入「加载 → 空闲释放」的循环。
  const loadSessionFromIdle = model.loadSession;
  const modelStatusState = model.status?.state;
  const modelIsSupported = model.supported;
  useEffect(() => {
    if (!captionsOn || !options.featureEnabled || !modelIsSupported) return;
    if (!options.mediaAvailable || modelStatusState !== "idle") return;
    pendingEnableRef.current = true;
    void loadSessionFromIdle().catch(() => {
      pendingEnableRef.current = false;
    });
  }, [
    captionsOn,
    loadSessionFromIdle,
    modelIsSupported,
    modelStatusState,
    options.featureEnabled,
    options.mediaAvailable,
  ]);

  useEffect(() => {
    /* 功能或模型不可用时整条字幕管线复位。外部会话编排：epoch 栅栏与计时器
       清理必须与状态写入原子地同步发生，以围栏在途识别任务。 */
    /* oxlint-disable react/set-state-in-effect */
    if (!options.featureEnabled || !model.supported) {
      setCaptionsOn(false);
      setCaption(null);
      setPartial(null);
      setNotice(null);
      setCaptureError(null);
      pendingJobRef.current = null;
      pendingEnableRef.current = false;
      epochRef.current += 1;
      clearCaptionTimer();
    }
    /* oxlint-enable react/set-state-in-effect */
  }, [clearCaptionTimer, model.supported, options.featureEnabled]);

  // 切房间或换媒体元素时清空流式解码状态。外部会话编排：包含 asr_reset_stream
  // IPC 与 epoch 栅栏，状态写入与其同步发生。
  useEffect(() => {
    /* oxlint-disable react/set-state-in-effect */
    setCaption(null);
    setPartial(null);
    setNotice(null);
    setCaptureError(null);
    pendingJobRef.current = null;
    epochRef.current += 1;
    chunkSetterRef.current = null;
    clearCaptionTimer();
    /* oxlint-enable react/set-state-in-effect */
    // 流式解码跨窗口保持状态，因此切换房间或媒体元素时必须清空它，
    // 否则下一条字幕会从上一条语句中间继续。
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
    // 登记活动消费者：空闲看门狗据此不释放会话。
    // 字幕开着但媒体暂停时不产生转写请求，但模型仍必须常驻。
    // 登记与注销必须成对：IPC 往返期间就卸载时，登记完成后立即补发注销，
    // 否则计数会永远留在 1，模型再也不会被空闲释放。
    let streamingRegistered = false;
    const stopStreaming = () => {
      streamingRegistered = false;
      return invokeCmd("asr_streaming_stopped").catch(() => undefined);
    };
    const streamingRequest = invokeCmd("asr_streaming_started")
      .then(() => {
        streamingRegistered = true;
        if (cancelled) void stopStreaming();
      })
      .catch(() => undefined);
    void subscribeToVideoPcm(video, (pcm) => {
      // 每完成一个窗口立即发布；当推理慢于播放时，
      // 只保留最新一个尚未开始的窗口。
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
      void streamingRequest.then(() => {
        if (streamingRegistered) void stopStreaming();
      });
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

  const modelSupported = model.supported;
  const modelState = model.status?.state;
  const modelQueryError = model.queryError;
  const loadSession = model.loadSession;
  const toggle = useCallback(() => {
    if (!localAsrClient || !modelSupported || !options.featureEnabled) return;
    if (modelState === "error" || modelQueryError) {
      // 失败后重试：`asr_load_session` 会重新校验/补齐资产再加载会话，
      // 一次点击就能把用户带回可看状态。
      setNotice(null);
      setCaptureError(null);
      pendingEnableRef.current = true;
      void loadSession().catch((error) => {
        pendingEnableRef.current = false;
        setNotice(`模型准备失败：${errorMessage(error)}`);
      });
      return;
    }
    // 资产就绪（`downloaded`/`idle`）时先按需加载会话，加载完成后
    // 由 status 变为 `ready` 触发采集。这里不阻塞点击：会话加载可能要几秒，
    // 状态轮询会把进度画在控件上。
    if (modelState === "downloaded" || modelState === "idle") {
      setNotice(null);
      setCaptureError(null);
      pendingEnableRef.current = true;
      void loadSession().catch((error) => {
        pendingEnableRef.current = false;
        setNotice(`模型加载失败：${errorMessage(error)}`);
      });
      return;
    }
    if (modelState !== "ready" || !options.mediaAvailable) return;

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
        // 用户在会话加载期间又点了关闭：取消先前登记的开启意图。
        pendingEnableRef.current = false;
        epochRef.current += 1;
        clearCaptionTimer();
        void invokeCmd("asr_reset_stream").catch(() => {});
      }
      return next;
    });
  }, [
    clearCaptionTimer,
    loadSession,
    localAsrClient,
    modelQueryError,
    modelState,
    modelSupported,
    options.featureEnabled,
    options.mediaAvailable,
  ]);

  const statusPresentation = describeAsrModelStatus(model.status, {
    enabled: options.featureEnabled,
    supported: model.supported,
    queryError: model.queryError,
  });

  let controlLabel = captionsOn ? "关闭语音字幕" : "开启语音字幕";
  let controlDisabled = false;
  // 启用字幕之后识别仍在继续。为每个窗口显示转圈会让字幕图标闪烁，
  // 因此 busy 只描述准备阶段。
  let controlBusy = false;
  if (!isTauri() || !localAsrClient) {
    controlLabel = "语音字幕仅在 Tauri 桌面客户端可用";
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
  } else if (model.status?.state === "downloaded" || model.status?.state === "idle") {
    // 资产已就绪但会话未加载：点击即按需加载，不阻断用户。
    controlLabel = "开启语音字幕";
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
    translatedCaption: translation.translatedCaption,
    partial,
    notice,
    translationNotice: translation.translationNotice,
    translationPending: translation.translationPending,
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
