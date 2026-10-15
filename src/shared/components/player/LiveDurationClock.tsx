import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  formatLiveDurationClock,
  formatLiveDurationLabel,
  liveDurationTickDelayMs,
} from "@/shared/liveDuration";

/**
 * 直播时长秒表：底部控制栏左组右端的只读读数。
 *
 * 心跳刻意留在叶子组件里：左组的兄弟节点包括暂停、刷新与音量，中央槽位是弹幕
 * 发送框，把 1Hz 状态提到 `PlayerControls` 会让整条控制栏（含输入框）每秒重渲染。
 *
 * 每拍都重新对齐真实秒边界并重算「现在 − 开播时间」，不累加计时器：WebView 在
 * 后台会节流定时器，累加会把节流掉的秒数永久丢掉，而重算在回到前台的第一拍就补齐。
 */
export function LiveDurationClock({
  liveStartedAt,
  className,
}: {
  liveStartedAt: number | null | undefined;
  className?: string;
}) {
  const active = liveStartedAt != null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;

    let timer: number | undefined;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      timer = window.setTimeout(tick, liveDurationTickDelayMs(current));
    };
    tick();

    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [active, liveStartedAt]);

  const clock = formatLiveDurationClock(liveStartedAt, now);
  const label = formatLiveDurationLabel(liveStartedAt, now);
  if (clock === null || label === null) return null;

  return (
    <span
      data-slot="player-live-duration"
      // 只读读数，不是计数器：`role="timer"` 的隐性 live 语义为 off，屏幕阅读器
      // 不会每秒播报一次；完整说法交给可访问名与悬停提示。
      role="timer"
      aria-label={label}
      title={label}
      className={cn(
        "shrink-0 tabular-nums",
        // 窄舞台上让位给中央弹幕输入框，与进度行收起剩余时间是同一条取舍。
        "media-max-sm:hidden",
        className,
      )}
    >
      {clock}
    </span>
  );
}
