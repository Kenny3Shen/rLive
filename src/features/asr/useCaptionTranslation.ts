import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
} from "@/shared/types/live";
import { appendAsrCaptionLine, formatAsrCaptionSegment } from "./audio";
import { captionTranslationClient, describeCaptionTranslationFailure } from "./translation";

type CaptionSegment = {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker_id: number | null;
};

type TranslationJob = {
  segments: CaptionSegment[];
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
}) {
  const [translatedCaption, setTranslatedCaption] = useState<string | null>(null);
  const [translationNotice, setTranslationNotice] = useState<string | null>(null);
  const [translationPending, setTranslationPending] = useState(false);
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
      setTranslatedCaption(null);
      setTranslationNotice(null);
      setTranslationPending(false);
      clearCaptionTimer();
    },
    [clearCaptionTimer],
  );

  const processPendingJobs = useCallback(async () => {
    if (workerRunningRef.current) return;
    workerRunningRef.current = true;
    setTranslationPending(true);
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
          if (remainingMs <= 0) continue;
          for (const [index, segment] of job.segments.entries()) {
            const text = translatedSegments[index];
            if (!text) continue;
            setTranslatedCaption((current) =>
              appendAsrCaptionLine(current, formatAsrCaptionSegment({ ...segment, text })),
            );
          }
          setTranslationNotice(null);
          clearCaptionTimer();
          captionTimerRef.current = window.setTimeout(() => {
            setTranslatedCaption(null);
            captionTimerRef.current = null;
          }, remainingMs);
        } catch (error) {
          if (job.epoch !== epochRef.current) continue;
          const failure = describeCaptionTranslationFailure(error);
          setTranslationNotice(failure.message);
          if (failure.kind === "rate_limited") {
            rateLimitedRef.current = true;
            pendingJobsRef.current = [];
          }
        }
      }
    } finally {
      workerRunningRef.current = false;
      setTranslationPending(false);
      if (pendingJobsRef.current.length > 0) void processPendingJobs();
    }
  }, [clearCaptionTimer]);

  const enqueue = useCallback(
    (segments: CaptionSegment[]) => {
      if (
        !options.active ||
        !options.enabled ||
        (options.from === options.to && options.from !== "auto") ||
        segments.length === 0 ||
        rateLimitedRef.current
      ) {
        return;
      }

      setTranslationNotice(null);
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
    [options.active, options.enabled, options.from, options.to, processPendingJobs],
  );

  useEffect(() => {
    reset(true);
  }, [options.active, options.enabled, options.from, options.to, reset]);

  useEffect(() => {
    reset(false);
  }, [options.mediaKey, options.sessionKey, reset]);

  useEffect(() => () => clearCaptionTimer(), [clearCaptionTimer]);

  return {
    translatedCaption,
    translationNotice,
    translationPending,
    enqueue,
  };
}
