/**
 * 直播时长文案。关注列表、房间侧栏与播放器控制栏共用同一份判定。
 *
 * 未知、非法和未来的开播时间一律渲染为空，而不暗示平台并未提供的时长。
 * 时长始终由「现在 − 开播时间」现算，不累加计时器：WebView 在后台会节流定时器，
 * 累加会把节流掉的秒数永久丢掉。
 */

const MINUTE_MS = 60_000;

/**
 * 校验过的开播时间戳；未知、非法或落在未来时为 null。
 *
 * 所有时长文案都从这里取校验结果，因此「什么算有效开播时间」只有一处定义；
 * 需要具体时间戳的地方（例如拼开播时刻）也能直接拿到窄化后的 `number`，
 * 不必再补一次断言。
 */
export function validLiveStartedAt(
  liveStartedAt: number | null | undefined,
  now = Date.now(),
): number | null {
  if (
    liveStartedAt == null ||
    !Number.isFinite(liveStartedAt) ||
    liveStartedAt <= 0 ||
    liveStartedAt > now
  ) {
    return null;
  }
  return liveStartedAt;
}

/** 已开播毫秒数；开播时间未知、非法或落在未来时返回 null。 */
export function liveElapsedMs(
  liveStartedAt: number | null | undefined,
  now = Date.now(),
): number | null {
  const startedAt = validLiveStartedAt(liveStartedAt, now);
  return startedAt === null ? null : now - startedAt;
}

/** 关注列表与房间侧栏使用的紧凑中文文案。 */
export function formatLiveDurationText(
  liveStartedAt: number | null | undefined,
  now = Date.now(),
): string | null {
  const elapsed = liveElapsedMs(liveStartedAt, now);
  if (elapsed === null) return null;

  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 1) return "刚刚开播";
  if (minutes < 60) return `${minutes} 分钟`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days} 天 ${remainingHours} 小时` : `${days} 天`;
}

/**
 * 播放器控制栏的秒级时钟：`mm:ss`，满一小时起显示 `hh:mm:ss`。
 *
 * 控制栏是横向空间最紧张的一处，因此这里不用中文长文案；完整说法留给悬停提示。
 */
export function formatLiveDurationClock(
  liveStartedAt: number | null | undefined,
  now = Date.now(),
): string | null {
  const elapsed = liveElapsedMs(liveStartedAt, now);
  if (elapsed === null) return null;

  const totalSeconds = Math.floor(elapsed / 1_000);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const minutes = String(Math.floor(totalSeconds / 60) % 60).padStart(2, "0");
  const hours = Math.floor(totalSeconds / 3_600);
  // 小时也补零：位数在整点处变化会让这一小段文字左右跳动。
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${minutes}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** 控制栏时长条目的悬停提示：中文时长加上开播时刻。 */
export function formatLiveDurationLabel(
  liveStartedAt: number | null | undefined,
  now = Date.now(),
): string | null {
  const startedAt = validLiveStartedAt(liveStartedAt, now);
  if (startedAt === null) return null;
  return `当前直播时长：${formatLiveDurationText(startedAt, now)}（开播于 ${formatLocalClock(startedAt)}）`;
}

/**
 * 到下一个整秒的毫秒数（留一点余量），把秒级心跳对齐到真实秒边界。
 *
 * 从挂载时刻起算的 1s 心跳会让秒位比真实时间最多晚一秒翻动，且这个偏移随每次
 * 挂载重新洗牌。返回值恒为正，不会退化成忙循环。
 */
export function liveDurationTickDelayMs(now = Date.now()): number {
  return 1_000 - (now % 1_000) + 20;
}

/** 本地 `HH:mm`；按字段手工拼装，不依赖 WebView 的 `zh-CN` 时制。 */
function formatLocalClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
