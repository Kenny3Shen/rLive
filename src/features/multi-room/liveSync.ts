/**
 * 多视图直播时钟对齐（导演网格"直播时钟同步"）。
 *
 * 刻意区分两种层级，因为并非所有直播流都带有可用的挂钟时间：
 *
 * - `manual`：每条流被固定落后于自身直播边缘用户指定的秒数。
 * 不涉及绝对时钟，因此在所有站点都可用。
 * - `auto`：各流被拉到同一个共享挂钟位置。HLS 通过
 * `EXT-X-PROGRAM-DATE-TIME` 提供精确时钟；FLV/MPEG-TS 只能从代理的
 * 首媒体字节纪元得到估计值，其中仍含 CDN 边缘突发。估计值在多条流之间可比
 * 但并不精确，因此每条流的微调始终保持可用。
 *
 * 本模块刻意保持纯函数：控制器采样播放器、调用 `planLiveSync` 并应用返回的
 * 校正。帧级精确同步明确不在范围内 —— 校正在容差带内即停止。
 */

export const LIVE_SYNC_MODES = ["off", "manual", "auto"] as const;
export type LiveSyncMode = (typeof LIVE_SYNC_MODES)[number];

/** 一条流的媒体位置如何映射到挂钟时间。 */
export type LiveSyncClockKind =
  /** 来自 HLS 播放列表的 `EXT-X-PROGRAM-DATE-TIME`。 */
  | "program-date"
  /** 由代理首媒体字节纪元估计（FLV / MPEG-TS）。 */
  | "stream-anchor"
  /** 尚无可用的时钟；只能让该流落后于自身的直播边缘。 */
  | "none";

/** 任何用户偏移之前，该流落后于自身直播边缘的秒数。 */
export const LIVE_SYNC_BASE_HOLD_SECONDS = 1.2;
/** 校正允许瞄准的、距直播边缘的最小距离。 */
export const LIVE_SYNC_EDGE_MARGIN_SECONDS = 0.6;
/** 校正允许瞄准的、距保留缓冲区起点的最小距离。 */
export const LIVE_SYNC_BUFFER_MARGIN_SECONDS = 0.4;
/** 用户偏移范围，单位秒。负值把该流提前到组之前。 */
export const LIVE_SYNC_OFFSET_MIN_SECONDS = -5;
export const LIVE_SYNC_OFFSET_MAX_SECONDS = 20;
export const LIVE_SYNC_OFFSET_STEP_SECONDS = 0.5;
/** `auto` 模式下共享目标延迟的取值范围。 */
export const LIVE_SYNC_MIN_TARGET_LATENCY_SECONDS = 1;
export const LIVE_SYNC_MAX_TARGET_LATENCY_SECONDS = 40;
/** 低于此值的误差不予处理；同步在设计上就不是帧级精确。 */
export const LIVE_SYNC_TOLERANCE_SECONDS = 0.35;
/** 超过此值时直接跳转，而不是微调播放速率。 */
export const LIVE_SYNC_SEEK_THRESHOLD_SECONDS = 1.5;
/** 静音的次要流在收敛期间应用的速率微调。 */
export const LIVE_SYNC_RATE_TRIM = 0.03;
/** 每个 tick 共享目标向更小延迟靠近的最大速度。 */
export const LIVE_SYNC_TARGET_RELEASE_SECONDS = 0.35;
/** 在最慢流可达位置之上保留的额外余量。 */
export const LIVE_SYNC_TARGET_MARGIN_SECONDS = 0.3;

export type LiveSyncSample = {
  key: string;
  /** 有声的那条流：它是参考时钟，绝不会被速率微调。 */
  main: boolean;
  /** 正在播放且至少有一个已缓冲区段。 */
  ready: boolean;
  mediaTime: number;
  bufferStart: number;
  /** 该流自身媒体时间轴上的直播边缘。 */
  bufferEnd: number;
  clockKind: LiveSyncClockKind;
  /** 存在时钟时与 `mediaTime === 0` 对应的纪元（毫秒）。 */
  epochAtMediaZeroMs: number | null;
  /** 每条流的用户偏移（秒）；正值延迟该流。 */
  offsetSeconds: number;
  playbackRate: number;
};

export type LiveSyncAction =
  /** 无事可做：已在容差内，或无法进行校正。 */
  | { kind: "hold"; rate: 1 }
  | { kind: "rate"; rate: number }
  | { kind: "seek"; mediaTime: number; rate: 1 };

export type LiveSyncFeedPlan = {
  key: string;
  action: LiveSyncAction;
  /** 该流偏离目标的带符号秒数（正 = 过晚）。 */
  errorSeconds: number | null;
  /** 应用本计划后落后于直播边缘的秒数。 */
  holdSeconds: number | null;
  clockKind: LiveSyncClockKind;
  /** 缓冲无法到达目标位置；偏移已被钳制。 */
  limited: boolean;
};

export type LiveSyncPlan = {
  /** `auto` 模式下落后于挂钟的共享延迟，否则为 null。 */
  targetLatencySeconds: number | null;
  feeds: LiveSyncFeedPlan[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeLiveSyncMode(mode: unknown): LiveSyncMode {
  return LIVE_SYNC_MODES.includes(mode as LiveSyncMode) ? (mode as LiveSyncMode) : "off";
}

export function normalizeLiveSyncOffset(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 0;
  const stepped =
    Math.round(seconds / LIVE_SYNC_OFFSET_STEP_SECONDS) * LIVE_SYNC_OFFSET_STEP_SECONDS;
  return clamp(stepped, LIVE_SYNC_OFFSET_MIN_SECONDS, LIVE_SYNC_OFFSET_MAX_SECONDS);
}

/** 该流当前显示帧对应的挂钟纪元（毫秒）。 */
export function liveSyncEpochPositionMs(sample: LiveSyncSample): number | null {
  if (sample.clockKind === "none" || sample.epochAtMediaZeroMs == null) return null;
  return sample.epochAtMediaZeroMs + sample.mediaTime * 1_000;
}

/** 按其时钟映射计算的、该流落后挂钟的秒数。 */
export function liveSyncLatencySeconds(sample: LiveSyncSample, nowMs: number): number | null {
  const position = liveSyncEpochPositionMs(sample);
  if (position == null) return null;
  return (nowMs - position) / 1_000;
}

/**
 * 一条流实际可播放的最小延迟：即其直播边缘再保留一段余量，
 * 避免校正落在未缓冲的位置上。
 */
function reachableLatencySeconds(sample: LiveSyncSample, nowMs: number): number | null {
  const latency = liveSyncLatencySeconds(sample, nowMs);
  if (latency == null) return null;
  const edgeDistance = Math.max(0, sample.bufferEnd - sample.mediaTime);
  return latency - edgeDistance + LIVE_SYNC_EDGE_MARGIN_SECONDS;
}

/**
 * 所有流被拉到的共享延迟。
 *
 * 由主流决定，因为它是唯一有声的一条且绝不能被速率微调：
 * 目标是主播放落后自身直播边缘 `LIVE_SYNC_BASE_HOLD_SECONDS` 时的延迟。
 * 这样整组的实时程度等于有声流所能达到的上限，而且不像追随主流瞬时位置那样，
 * 会在每次重新缓冲时越退越远。
 *
 * 较慢的次要流仍能把整组拖回来：在保留缓冲区内延迟一条流总是可行，
 * 而越过直播边缘追赶则不然。
 */
export function liveSyncTargetLatencySeconds(
  samples: readonly LiveSyncSample[],
  nowMs: number,
  previousTargetSeconds: number | null,
): number | null {
  const ready = samples.filter((sample) => sample.ready);
  if (ready.length === 0) return null;
  const mainCandidate = ready
    .filter((sample) => sample.main)
    .map((sample) => {
      const latency = liveSyncLatencySeconds(sample, nowMs);
      if (latency == null) return null;
      const edgeDistance = Math.max(0, sample.bufferEnd - sample.mediaTime);
      return latency - edgeDistance + LIVE_SYNC_BASE_HOLD_SECONDS;
    })
    .find((latency): latency is number => latency != null);
  const floors = ready
    .map((sample) => {
      const reachable = reachableLatencySeconds(sample, nowMs);
      if (reachable == null) return null;
      // 要求跑到组之前的流，需要共享目标先退后相应距离，
      // 其自身偏移才变得可达。
      return reachable - Math.min(0, sample.offsetSeconds) + LIVE_SYNC_TARGET_MARGIN_SECONDS;
    })
    .filter((latency): latency is number => latency != null);
  const candidates = [...(mainCandidate == null ? [] : [mainCandidate]), ...floors];
  if (candidates.length === 0) return null;

  const desired = clamp(
    Math.max(...candidates),
    LIVE_SYNC_MIN_TARGET_LATENCY_SECONDS,
    LIVE_SYNC_MAX_TARGET_LATENCY_SECONDS,
  );
  if (previousTargetSeconds == null || desired >= previousTargetSeconds) return desired;
  // 缓慢释放延迟可以避免一条流的重新缓冲
  // 带着整个网格来回摆动。
  return Math.max(desired, previousTargetSeconds - LIVE_SYNC_TARGET_RELEASE_SECONDS);
}

function feedCorrection(
  sample: LiveSyncSample,
  targetMediaTime: number,
): { action: LiveSyncAction; errorSeconds: number; limited: boolean } {
  const lowerBound = sample.bufferStart + LIVE_SYNC_BUFFER_MARGIN_SECONDS;
  const upperBound = sample.bufferEnd - LIVE_SYNC_EDGE_MARGIN_SECONDS;
  const reachable =
    upperBound <= lowerBound
      ? clamp(sample.mediaTime, Math.min(lowerBound, upperBound), Math.max(lowerBound, upperBound))
      : clamp(targetMediaTime, lowerBound, upperBound);
  const limited = Math.abs(reachable - targetMediaTime) > LIVE_SYNC_TOLERANCE_SECONDS;
  // 正误差：该流显示的画面比应有的更旧。
  const errorSeconds = reachable - sample.mediaTime;

  const magnitude = Math.abs(errorSeconds);
  if (magnitude <= LIVE_SYNC_TOLERANCE_SECONDS) {
    return { action: { kind: "hold", rate: 1 }, errorSeconds, limited };
  }
  if (magnitude >= LIVE_SYNC_SEEK_THRESHOLD_SECONDS) {
    return { action: { kind: "seek", mediaTime: reachable, rate: 1 }, errorSeconds, limited };
  }
  // 有声流的音调绝不能被改变，所以它只会跳转 ——
  // 而且只在误差大到值得一次可见切换时才跳。
  if (sample.main) return { action: { kind: "hold", rate: 1 }, errorSeconds, limited };
  const rate = errorSeconds > 0 ? 1 + LIVE_SYNC_RATE_TRIM : 1 - LIVE_SYNC_RATE_TRIM;
  return { action: { kind: "rate", rate }, errorSeconds, limited };
}

/**
 * 为每条流决定一次校正。
 *
 * `manual` 让每条流落后于自身直播边缘；`auto` 用各自的时钟把每条流映射到
 * `targetLatencySeconds`，尚无时钟的流回退到 manual 规则。
 */
export function planLiveSync(input: {
  mode: LiveSyncMode;
  samples: readonly LiveSyncSample[];
  nowMs: number;
  previousTargetSeconds: number | null;
}): LiveSyncPlan {
  const { mode, samples, nowMs, previousTargetSeconds } = input;
  if (mode === "off") {
    return {
      targetLatencySeconds: null,
      feeds: samples.map((sample) => ({
        key: sample.key,
        action: { kind: "hold", rate: 1 },
        errorSeconds: null,
        holdSeconds: null,
        clockKind: sample.clockKind,
        limited: false,
      })),
    };
  }

  const targetLatencySeconds =
    mode === "auto" ? liveSyncTargetLatencySeconds(samples, nowMs, previousTargetSeconds) : null;

  const feeds = samples.map<LiveSyncFeedPlan>((sample) => {
    if (!sample.ready) {
      return {
        key: sample.key,
        action: { kind: "hold", rate: 1 },
        errorSeconds: null,
        holdSeconds: null,
        clockKind: sample.clockKind,
        limited: false,
      };
    }

    const latency = mode === "auto" ? liveSyncLatencySeconds(sample, nowMs) : null;
    const targetMediaTime =
      targetLatencySeconds != null && latency != null
        ? sample.mediaTime + (latency - (targetLatencySeconds + sample.offsetSeconds))
        : // 无时钟时改为让该流落后于自身直播边缘。
          sample.bufferEnd - (LIVE_SYNC_BASE_HOLD_SECONDS + Math.max(0, sample.offsetSeconds));
    const { action, errorSeconds, limited } = feedCorrection(sample, targetMediaTime);
    const resolvedMediaTime = action.kind === "seek" ? action.mediaTime : sample.mediaTime;
    return {
      key: sample.key,
      action,
      errorSeconds,
      holdSeconds: Math.max(0, sample.bufferEnd - resolvedMediaTime),
      clockKind: mode === "auto" && latency == null ? "none" : sample.clockKind,
      limited,
    };
  });

  return { targetLatencySeconds, feeds };
}

/**
 * manual 模式的偏移量，使每条流都对齐到最慢流的挂钟。
 *
 * `manual` 让每条流落后于自身直播边缘，因此对齐就是给较快的流补足恰好等于
 * 其领先量的额外延迟。auto 模式连续做这件事；这里是一次性填充滑杆，
 * 用户随后仍可微调。没有时钟的流保持现有偏移。
 */
export function liveSyncManualAlignOffsets(
  samples: readonly LiveSyncSample[],
  nowMs: number,
): Record<string, number> {
  const edgeLatencies = new Map<string, number>();
  for (const sample of samples) {
    if (!sample.ready) continue;
    const latency = liveSyncLatencySeconds(sample, nowMs);
    if (latency == null) continue;
    edgeLatencies.set(sample.key, latency - Math.max(0, sample.bufferEnd - sample.mediaTime));
  }
  if (edgeLatencies.size === 0) return {};
  const slowest = Math.max(...edgeLatencies.values());
  const offsets: Record<string, number> = {};
  for (const [key, edgeLatency] of edgeLatencies) {
    offsets[key] = normalizeLiveSyncOffset(slowest - edgeLatency);
  }
  return offsets;
}
