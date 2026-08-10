import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { SiteId } from "@/shared/types/live";
import {
  AUTO_DANMAKU_SEND_DEFAULT_INTERVAL_SECONDS,
  AUTO_DANMAKU_SEND_INTERVAL_MS,
  nextAutoDanmakuSegmentIndex,
  normalizeAutoDanmakuSendIntervalSeconds,
  remainingAutoDanmakuSendDelay,
  splitAutoDanmakuText,
} from "./autoSend";
import { getDanmakuSendConfig, type DanmakuSendStatus } from "./sending";

export type AutoDanmakuSendPhase = "off" | "waiting" | "sending" | "paused";

/** Session-only state consumed by the right-side danmaku settings panel. */
export type AutoDanmakuSendController = {
  text: string;
  intervalSeconds: number;
  enabled: boolean;
  phase: AutoDanmakuSendPhase;
  canEnable: boolean;
  availabilityMessage: string;
  validationMessage: string | null;
  statusMessage: string;
  segmentCount: number;
  currentSegmentIndex: number | null;
  onTextChange: (value: string) => void;
  onIntervalChange: (seconds: number) => void;
  onEnabledChange: (enabled: boolean) => void;
};

type UseAutoDanmakuSendOptions = {
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  /** Changes for a direct room switch even when the component stays mounted. */
  roomSessionKey?: string;
};

type AvailabilitySnapshot = {
  key: string;
  status: DanmakuSendStatus;
};

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    const message = String((error as { message: unknown }).message).trim();
    if (message) return message;
  }
  return "发送请求失败，请检查账号状态或直播间限制。";
}

function immediateSendMessage(index: number, count: number): string {
  return `第 ${index + 1}/${count} 段将立即发送。`;
}

function waitingMessage(index: number, count: number, intervalMs: number): string {
  const intervalSeconds = intervalMs / 1_000;
  return `正在等待第 ${index + 1}/${count} 段；发送起始至少相隔 ${intervalSeconds} 秒。`;
}

/** `performance.now()` is monotonic, unlike wall-clock time after a system sync. */
function monotonicNow(): number {
  return performance.now();
}

function createInFlightCompletion(): { done: Promise<void>; finish: () => void } {
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { done, finish };
}

/**
 * Schedule a deliberate, session-scoped sequence of normal danmaku sends.
 * This hook belongs above the collapsible right panel so closing that panel
 * cannot silently stop a running sequence. It intentionally never persists
 * its draft or enabled state.
 */
export function useAutoDanmakuSend({
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  roomSessionKey,
}: UseAutoDanmakuSendOptions): AutoDanmakuSendController {
  const danmakuSendEnabled = useSettingsStore((state) => state.danmakuSendEnabled);
  const danmakuSendPending = useSettingsStore((state) => state.danmakuSendPending);
  const danmakuCookieRevision = useSettingsStore((state) => state.danmakuCookieRevision);
  const sendConfig = getDanmakuSendConfig(siteId);
  const [text, setText] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(
    AUTO_DANMAKU_SEND_DEFAULT_INTERVAL_SECONDS,
  );
  const [enabled, setEnabled] = useState(false);
  const [phase, setPhase] = useState<AutoDanmakuSendPhase>("off");
  const [statusMessage, setStatusMessage] = useState("已关闭。");
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState<number | null>(null);
  const [availability, setAvailability] = useState<AvailabilitySnapshot | null>(null);
  const inFlightRef = useRef(false);
  const inFlightDoneRef = useRef<Promise<void> | null>(null);
  const lastSendStartedAtRef = useRef<number | null>(null);
  const intervalMsRef = useRef(AUTO_DANMAKU_SEND_INTERVAL_MS);
  const rescheduleIntervalRef = useRef<((intervalMs: number) => void) | null>(null);
  intervalMsRef.current = intervalSeconds * 1_000;

  const roomKey = roomSessionKey ?? `${siteId ?? "unknown"}:${roomId ?? ""}`;
  const latestRoomKeyRef = useRef(roomKey);
  latestRoomKeyRef.current = roomKey;
  const latestRoomMetadataRef = useRef({ roomTitle, roomUserName });
  latestRoomMetadataRef.current = { roomTitle, roomUserName };

  const availabilityKey = [
    siteId ?? "",
    roomId ?? "",
    sendConfig?.statusCommand ?? "",
    danmakuSendEnabled ? "enabled" : "disabled",
    danmakuSendPending ? "pending" : "ready",
    String(danmakuCookieRevision),
  ].join("\u0000");
  const currentAvailability = availability?.key === availabilityKey ? availability.status : null;
  const validation = useMemo(
    () => splitAutoDanmakuText(text, sendConfig?.maxLength ?? Number.MAX_SAFE_INTEGER),
    [sendConfig?.maxLength, text],
  );
  // Effects clean timers after a render, but a due timer can otherwise sneak
  // in between a room/text/permission update and that cleanup. Keep a render
  // synchronous fence as well, so only the current session input may start a
  // request.
  const runKey = [
    roomKey,
    availabilityKey,
    sendConfig?.maxLength ?? "",
    validation.normalized,
    enabled ? "enabled" : "disabled",
  ].join("\u0000");
  const latestRunKeyRef = useRef(runKey);
  latestRunKeyRef.current = runKey;

  useEffect(() => {
    let cancelled = false;

    if (!sendConfig || !roomId || danmakuSendPending || !danmakuSendEnabled) {
      setAvailability(null);
      return () => {
        cancelled = true;
      };
    }

    setAvailability(null);
    void invokeCmd<DanmakuSendStatus>(sendConfig.statusCommand)
      .then((status) => {
        if (!cancelled) setAvailability({ key: availabilityKey, status });
      })
      .catch(() => {
        if (!cancelled) {
          setAvailability({
            key: availabilityKey,
            status: {
              send_enabled: false,
              cookie_ready: false,
              available: false,
              message: `暂时无法确认${sendConfig.siteLabel}发送权限。`,
            },
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [availabilityKey, danmakuSendEnabled, danmakuSendPending, roomId, sendConfig]);

  const availabilityMessage = !sendConfig
    ? "当前平台暂不支持自动发送弹幕。"
    : !roomId
      ? "正在等待直播间信息。"
      : danmakuSendPending
        ? "正在同步发送权限…"
        : !danmakuSendEnabled
          ? "请先在账号设置启用发送功能。"
          : (currentAvailability?.message ?? "正在检查发送权限…");
  const canEnable = Boolean(
    sendConfig &&
    roomId &&
    danmakuSendEnabled &&
    !danmakuSendPending &&
    currentAvailability?.available &&
    !validation.error,
  );

  // A route change can reuse PlayerPane. Keep a direct-room-switch from
  // carrying a session toggle into the newly mounted room.
  const previousRoomKeyRef = useRef(roomKey);
  useEffect(() => {
    if (previousRoomKeyRef.current === roomKey) return;
    previousRoomKeyRef.current = roomKey;
    setText("");
    setIntervalSeconds(AUTO_DANMAKU_SEND_DEFAULT_INTERVAL_SECONDS);
    setEnabled(false);
    setPhase("paused");
    setCurrentSegmentIndex(null);
    lastSendStartedAtRef.current = null;
    setStatusMessage("已暂停：已切换直播间。");
  }, [roomKey]);

  // Credentials, the shared consent switch, and local text validation are
  // live prerequisites. Losing any one stops the sequence instead of letting
  // a stale timer submit a request after the next render.
  useEffect(() => {
    if (!enabled || canEnable) return;
    setEnabled(false);
    setPhase("paused");
    setCurrentSegmentIndex(null);
    setStatusMessage(`已暂停：${validation.error ?? availabilityMessage}`);
  }, [availabilityMessage, canEnable, enabled, validation.error]);

  useEffect(() => {
    if (!enabled || !canEnable || !sendConfig || !roomId || validation.segments.length === 0) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    let scheduledSegmentIndex: number | null = null;
    const scheduledRoomKey = roomKey;
    const scheduledRunKey = runKey;
    const segments = validation.segments;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      scheduledSegmentIndex = null;
    };

    const schedule = (segmentIndex: number, delay: number) => {
      clearTimer();
      scheduledSegmentIndex = segmentIndex;
      timer = window.setTimeout(() => {
        timer = null;
        scheduledSegmentIndex = null;
        void sendSegment(segmentIndex);
      }, delay);
    };

    const rescheduleInterval = (intervalMs: number) => {
      const segmentIndex = scheduledSegmentIndex;
      if (segmentIndex === null || inFlightRef.current) return;

      setPhase("waiting");
      setCurrentSegmentIndex(segmentIndex);
      setStatusMessage(waitingMessage(segmentIndex, segments.length, intervalMs));
      schedule(
        segmentIndex,
        remainingAutoDanmakuSendDelay(lastSendStartedAtRef.current, monotonicNow(), intervalMs),
      );
    };
    rescheduleIntervalRef.current = rescheduleInterval;

    const sendSegment = async (segmentIndex: number) => {
      if (
        cancelled ||
        latestRoomKeyRef.current !== scheduledRoomKey ||
        latestRunKeyRef.current !== scheduledRunKey
      ) {
        return;
      }

      // A user can turn the feature off and back on while an old command is
      // finishing. Wait for its completion rather than polling or overlapping
      // write requests across room/session generations.
      if (inFlightRef.current) {
        setPhase("waiting");
        setCurrentSegmentIndex(segmentIndex);
        setStatusMessage("正在等待上一条弹幕发送完成。");
        const inFlightDone = inFlightDoneRef.current;
        if (inFlightDone) {
          void inFlightDone.finally(() => {
            if (
              cancelled ||
              latestRoomKeyRef.current !== scheduledRoomKey ||
              latestRunKeyRef.current !== scheduledRunKey
            ) {
              return;
            }
            schedule(segmentIndex, 0);
          });
        } else {
          schedule(segmentIndex, 0);
        }
        return;
      }

      const lastStartedAt = lastSendStartedAtRef.current;
      const minimumWait = remainingAutoDanmakuSendDelay(
        lastStartedAt,
        monotonicNow(),
        intervalMsRef.current,
      );
      if (minimumWait > 0) {
        schedule(segmentIndex, minimumWait);
        return;
      }

      const message = segments[segmentIndex];
      if (!message) return;

      inFlightRef.current = true;
      const inFlight = createInFlightCompletion();
      inFlightDoneRef.current = inFlight.done;
      const startedAt = monotonicNow();
      lastSendStartedAtRef.current = startedAt;
      setPhase("sending");
      setCurrentSegmentIndex(segmentIndex);
      setStatusMessage(`正在发送第 ${segmentIndex + 1}/${segments.length} 段。`);

      try {
        await invokeCmd<void>(sendConfig.sendCommand, {
          roomId,
          message,
          ...latestRoomMetadataRef.current,
        });
        if (
          cancelled ||
          latestRoomKeyRef.current !== scheduledRoomKey ||
          latestRunKeyRef.current !== scheduledRunKey
        ) {
          return;
        }

        const nextIndex = nextAutoDanmakuSegmentIndex(segmentIndex, segments.length);
        const intervalMs = intervalMsRef.current;
        setPhase("waiting");
        setCurrentSegmentIndex(nextIndex);
        setStatusMessage(waitingMessage(nextIndex, segments.length, intervalMs));
        schedule(nextIndex, remainingAutoDanmakuSendDelay(startedAt, monotonicNow(), intervalMs));
      } catch (error) {
        if (
          cancelled ||
          latestRoomKeyRef.current !== scheduledRoomKey ||
          latestRunKeyRef.current !== scheduledRunKey
        ) {
          return;
        }
        setEnabled(false);
        setPhase("paused");
        setCurrentSegmentIndex(segmentIndex);
        setStatusMessage(`已暂停：发送失败：${errorMessage(error)}`);
      } finally {
        inFlightRef.current = false;
        inFlight.finish();
        if (inFlightDoneRef.current === inFlight.done) {
          inFlightDoneRef.current = null;
        }
      }
    };

    const intervalMs = intervalMsRef.current;
    const initialDelay = remainingAutoDanmakuSendDelay(
      lastSendStartedAtRef.current,
      monotonicNow(),
      intervalMs,
    );
    setPhase("waiting");
    setCurrentSegmentIndex(0);
    setStatusMessage(
      initialDelay === 0
        ? immediateSendMessage(0, segments.length)
        : waitingMessage(0, segments.length, intervalMs),
    );
    schedule(0, initialDelay);

    return () => {
      cancelled = true;
      clearTimer();
      if (rescheduleIntervalRef.current === rescheduleInterval) {
        rescheduleIntervalRef.current = null;
      }
    };
  }, [canEnable, enabled, roomId, roomKey, runKey, sendConfig, validation.segments]);

  const onTextChange = useCallback(
    (value: string) => {
      setText(value);
      if (!enabled) return;
      setEnabled(false);
      setPhase("paused");
      setCurrentSegmentIndex(null);
      setStatusMessage("已暂停：编辑内容后请重新开启自动发送。");
    },
    [enabled],
  );

  const onIntervalChange = useCallback((seconds: number) => {
    const nextSeconds = normalizeAutoDanmakuSendIntervalSeconds(seconds);
    const nextIntervalMs = nextSeconds * 1_000;
    intervalMsRef.current = nextIntervalMs;
    setIntervalSeconds(nextSeconds);
    rescheduleIntervalRef.current?.(nextIntervalMs);
  }, []);

  const onEnabledChange = useCallback(
    (nextEnabled: boolean) => {
      if (!nextEnabled) {
        setEnabled(false);
        setPhase("off");
        setCurrentSegmentIndex(null);
        setStatusMessage("已关闭。");
        return;
      }

      if (!canEnable) {
        setEnabled(false);
        setPhase("paused");
        setCurrentSegmentIndex(null);
        setStatusMessage(`已暂停：${validation.error ?? availabilityMessage}`);
        return;
      }

      // A deliberate re-enable starts a fresh sequence. The first message is
      // not held behind the previous sequence's configured interval.
      lastSendStartedAtRef.current = null;
      setEnabled(true);
      setPhase("waiting");
      setCurrentSegmentIndex(0);
      setStatusMessage(immediateSendMessage(0, validation.segments.length));
    },
    [availabilityMessage, canEnable, validation.error, validation.segments.length],
  );

  return {
    text,
    intervalSeconds,
    enabled,
    phase,
    canEnable,
    availabilityMessage,
    validationMessage: validation.error,
    statusMessage: phase === "off" ? (canEnable ? "已关闭。" : availabilityMessage) : statusMessage,
    segmentCount: validation.segments.length,
    currentSegmentIndex,
    onTextChange,
    onIntervalChange,
    onEnabledChange,
  };
}
