import { useCallback, useEffect, useRef } from "react";
import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
} from "@/shared/types/live";
import { appendAsrCaptionLine, formatAsrCaptionSegment } from "./audio";
import type { AsrCaptionTextStore } from "./asrCaptionText";
import { captionTranslationClient, describeCaptionTranslationFailure } from "./translation";

type CaptionSegment = {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker_id: number | null;
};

/**
 * 带转录条目 id 的定稿语句。独立字幕窗口打开时，id 用于把迟到的译文回填到
 * 对应行；其他宿主不提供转录，字段始终为空。
 */
type TranslationSegment = CaptionSegment & { transcriptId?: string };

type TranslationJob = {
  segments: TranslationSegment[];
  from: CaptionTranslationSourceLanguage;
  to: CaptionTranslationLanguage;
  epoch: number;
  expiresAt: number;
};

const CAPTION_RETENTION_MS = 12_000;
const MAX_PENDING_TRANSLATION_JOBS = 4;

export function useCaptionTranslation(options: {
  active: boolean;
  enabled: boolean;
  from: CaptionTranslationSourceLanguage;
  to: CaptionTranslationLanguage;
  mediaKey: number;
  sessionKey: string;
  /** 译文与翻译提示写入叠加层的文本 store，宿主不随翻译批次重渲染。 */
  text: AsrCaptionTextStore;
  /**
   * 译文回填到独立字幕窗口的转录条目。即使叠加层已超过保留时间也调用，
   * 让整场对话的译文保持完整。
   */
  onSegmentTranslated?: (transcriptId: string, translatedText: string) => void;
}) {
  const text = options.text;
  const onSegmentTranslated = options.onSegmentTranslated;
  const epochRef = useRef(0);
  const workerRunningRef = useRef(false);
  const pendingJobsRef = useRef<TranslationJob[]>([]);
  const captionTimerRef = useRef<number | null>(null);
  const rateLimitedRef = useRef(false);

  const clearCaptionTimer = useCallback(() => {
    if (captionTimerRef.current !== null) {
      window.clearTimeout(captionTimerRef.current);
      captionTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(
    (clearRateLimit: boolean) => {
      epochRef.current += 1;
      pendingJobsRef.current = [];
      if (clearRateLimit) rateLimitedRef.current = false;
      text.update({ translatedCaption: null, translationNotice: null });
      clearCaptionTimer();
    },
    [clearCaptionTimer, text],
  );

  const processPendingJobs = useCallback(async () => {
    if (workerRunningRef.current) return;
    workerRunningRef.current = true;
    try {
      while (pendingJobsRef.current.length > 0) {
        const job = pendingJobsRef.current.shift();
        if (!job || job.epoch !== epochRef.current) continue;

        try {
          const translatedSegments = await captionTranslationClient.translateBatch(
            job.segments.map((segment) => segment.text),
            job.from,
            job.to,
          );
          if (job.epoch !== epochRef.current) continue;

          const remainingMs = job.expiresAt - Date.now();
          for (const [index, segment] of job.segments.entries()) {
            const translated = translatedSegments[index];
            if (!translated) continue;
            const formatted = formatAsrCaptionSegment({ ...segment, text: translated });
            // 转录不设过期：翻译比叠加层慢时，字幕窗口仍应拿到这一行译文。
            if (segment.transcriptId) onSegmentTranslated?.(segment.transcriptId, formatted);
            if (remainingMs <= 0) continue;
            text.update((current) => ({
              translatedCaption: appendAsrCaptionLine(current.translatedCaption, formatted),
            }));
          }
          if (remainingMs <= 0) continue;
          text.update({ translationNotice: null });
          clearCaptionTimer();
          captionTimerRef.current = window.setTimeout(() => {
            text.update({ translatedCaption: null });
            captionTimerRef.current = null;
          }, remainingMs);
        } catch (error) {
          if (job.epoch !== epochRef.current) continue;
          const failure = describeCaptionTranslationFailure(error);
          text.update({ translationNotice: failure.message });
          if (failure.kind === "rate_limited") {
            rateLimitedRef.current = true;
            pendingJobsRef.current = [];
          }
        }
      }
    } finally {
      workerRunningRef.current = false;
      if (pendingJobsRef.current.length > 0) void processPendingJobs();
    }
  }, [clearCaptionTimer, onSegmentTranslated, text]);

  const enqueue = useCallback(
    (segments: TranslationSegment[]) => {
      if (
        !options.active ||
        !options.enabled ||
        (options.from === options.to && options.from !== "auto") ||
        segments.length === 0 ||
        rateLimitedRef.current
      ) {
        return;
      }

      text.update({ translationNotice: null });
      pendingJobsRef.current.push({
        segments,
        from: options.from,
        to: options.to,
        epoch: epochRef.current,
        expiresAt: Date.now() + CAPTION_RETENTION_MS,
      });
      if (pendingJobsRef.current.length > MAX_PENDING_TRANSLATION_JOBS) {
        pendingJobsRef.current.splice(
          0,
          pendingJobsRef.current.length - MAX_PENDING_TRANSLATION_JOBS,
        );
      }
      void processPendingJobs();
    },
    [options.active, options.enabled, options.from, options.to, processPendingJobs, text],
  );

  // 外部会话编排：reset 含 epoch 栅栏、待办队列与计时器清理，文本清空与这些
  // 外部副作用必须同步发生。
  useEffect(() => {
    reset(true);
  }, [options.active, options.enabled, options.from, options.to, reset]);

  useEffect(() => {
    reset(false);
  }, [options.mediaKey, options.sessionKey, reset]);

  useEffect(() => () => clearCaptionTimer(), [clearCaptionTimer]);

  return { enqueue };
}
