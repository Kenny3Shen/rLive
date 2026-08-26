import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { notify } from "@/components/ui/toast";

export const DEFAULT_SLEEP_TIMER_MINUTES = 30;
export const MIN_SLEEP_TIMER_MINUTES = 1;
export const MAX_SLEEP_TIMER_MINUTES = 24 * 60;

export type SleepTimerController = {
  active: boolean;
  durationMinutes: number;
  remainingSeconds: number;
  start: (minutes: number) => void;
  cancel: () => void;
};

export function normalizeSleepTimerMinutes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SLEEP_TIMER_MINUTES;
  return Math.min(MAX_SLEEP_TIMER_MINUTES, Math.max(MIN_SLEEP_TIMER_MINUTES, Math.round(value)));
}

export function formatSleepTimer(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remaining = safeSeconds % 60;
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
}

async function closeApplication(): Promise<void> {
  if (!isTauri()) {
    notify.error("定时关闭不可用", "请在 rLive 客户端中使用此功能。");
    return;
  }

  try {
    await getCurrentWindow().close();
  } catch {
    notify.error("退出应用失败", "窗口关闭未完成，请手动关闭 rLive。");
  }
}

/**
 * 房间级定时关闭。截止时间保存为绝对时间戳，
 * 使 WebView 进入后台或间隔延迟都不会额外增加时间。
 */
export function useSleepTimer(roomSessionKey?: string): SleepTimerController {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_SLEEP_TIMER_MINUTES);
  const [now, setNow] = useState(() => Date.now());
  const previousRoomSessionKey = useRef(roomSessionKey);

  const cancel = useCallback(() => {
    setDeadline(null);
    setNow(Date.now());
  }, []);

  const start = useCallback((minutes: number) => {
    const normalizedMinutes = normalizeSleepTimerMinutes(minutes);
    setDurationMinutes(normalizedMinutes);
    setNow(Date.now());
    setDeadline(Date.now() + normalizedMinutes * 60_000);
  }, []);

  // 定时器属于房间会话。导航到另一个房间绝不能让过期计时器
  // 意外关掉新打开的会话。
  useEffect(() => {
    if (previousRoomSessionKey.current === roomSessionKey) return;
    previousRoomSessionKey.current = roomSessionKey;
    setDurationMinutes(DEFAULT_SLEEP_TIMER_MINUTES);
    cancel();
  }, [cancel, roomSessionKey]);

  useEffect(() => {
    if (deadline === null) return;

    const updateClock = () => setNow(Date.now());
    updateClock();
    const interval = window.setInterval(updateClock, 1_000);
    const timeout = window.setTimeout(
      () => {
        setDeadline(null);
        setNow(Date.now());
        void closeApplication();
      },
      Math.max(0, deadline - Date.now()),
    );

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [deadline]);

  const remainingSeconds = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1_000));

  return useMemo(
    () => ({
      active: deadline !== null,
      durationMinutes,
      remainingSeconds,
      start,
      cancel,
    }),
    [cancel, deadline, durationMinutes, remainingSeconds, start],
  );
}
