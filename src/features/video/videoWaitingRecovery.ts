/**
 * 点播 waiting 自动恢复决策器。
 *
 * B 站点播走三条代理会话取流，上游 Range 长期无字节时媒体元素会停在
 * waiting，而后端有序代理 8 秒读取空闲就释放请求——会话就此变哑，等是等
 * 不回来的。前端必须比后端释放更晚（默认 10 秒）才判定「这一轮会话已
 * 死」，然后走既有的重试链（记录续播点 → 递增 playerRevision → 重拉
 * play-info 与三代理会话）换新会话。
 *
 * 判定与计时装在独立模块、时钟走适配器：超时窗口、自动重试预算、稳定
 * 播放重置这些决策要能离屏单测，不依赖真实定时器。页面只负责把媒体
 * 事件喂进来、把决策结果接回同一条重建链路。
 */

/** 比后端有序代理 8 秒读取空闲释放更晚：抢在释放前重建，只会得到同样卡住的新会话。 */
export const VOD_WAITING_RECOVERY_TIMEOUT_MS = 10_000;
/** 同一 videoKey 连续自动重建的预算：上游永久故障时不至于每 10 秒无限重试。 */
export const VOD_WAITING_RECOVERY_MAX_AUTO_RETRIES = 2;
/** 稳定播放多久后把预算还回去：能稳定播说明上一轮故障是偶发而非连续。 */
export const VOD_WAITING_RECOVERY_STABLE_MS = 30_000;

export type VideoWaitingRecoveryClockAdapter = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: unknown): void;
};

const DEFAULT_CLOCK: VideoWaitingRecoveryClockAdapter = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
  clearTimer: (handle) => globalThis.clearTimeout(handle as number),
};

export type VideoWaitingRecoveryOptions = {
  /** 超时成立：走与手动重试同一条重建链路。 */
  onAutoRetry: () => void;
  /** 自动预算耗尽：改走可见错误面板，把重试交还给用户。 */
  onExhausted: () => void;
  /** 时钟适配器：默认真实定时器，单测注入假时钟。 */
  clock?: VideoWaitingRecoveryClockAdapter;
  timeoutMs?: number;
  maxAutoRetries?: number;
  stableMs?: number;
};

export type VideoWaitingRecovery = {
  /** 播放器会话（重新）挂载：换 key 重置预算；并作废上一会话挂起的计时。 */
  beginSession(videoKey: string): void;
  /** 播放器会话拆除（重建/换集/离开路由）：waiting 计时随之作废。 */
  endSession(): void;
  /** 媒体 waiting 事件：起超时判定计时（已挂起或已耗尽时忽略）。 */
  notifyWaiting(): void;
  /** waiting 解除（play/seeked）：取消计时，稳定播放从现在重新起算。 */
  notifyResumed(): void;
  /** 用户暂停：waiting 计时作废，暂停不该被自动重试拉起。 */
  notifyPaused(): void;
  /** 播完：waiting 计时作废。 */
  notifyEnded(): void;
  /** 媒体/播放器错误：错误面板接管，waiting 计时作废。 */
  notifyError(): void;
  /** 手动重试（错误面板/刷新播放）：用户亲自出手视同预算重置。 */
  notifyManualRetry(): void;
};

export function createVideoWaitingRecovery(
  options: VideoWaitingRecoveryOptions,
): VideoWaitingRecovery {
  const {
    onAutoRetry,
    onExhausted,
    clock = DEFAULT_CLOCK,
    timeoutMs = VOD_WAITING_RECOVERY_TIMEOUT_MS,
    maxAutoRetries = VOD_WAITING_RECOVERY_MAX_AUTO_RETRIES,
    stableMs = VOD_WAITING_RECOVERY_STABLE_MS,
  } = options;

  // 会话纪元：每次 beginSession 递增。计时回调带着发起时的纪元，比对不上
  // 就说明播放器已经重建/换集/拆除——过期计时绝不对新会话动手。
  let sessionEpoch = 0;
  let activeSession: number | null = null;
  let videoKey: string | null = null;
  let autoRetries = 0;
  let exhausted = false;
  let timerHandle: unknown = null;
  /** 上次 waiting 解除（恢复播放/seek 完成）的时刻；null = 本会话还没证明能播。 */
  let resumedAt: number | null = null;

  function cancelTimer() {
    if (timerHandle === null) return;
    clock.clearTimer(timerHandle);
    timerHandle = null;
  }

  return {
    beginSession(key) {
      sessionEpoch += 1;
      activeSession = sessionEpoch;
      // 上一会话挂起的 waiting 计时不许带进新会话。
      cancelTimer();
      if (key !== videoKey) {
        videoKey = key;
        autoRetries = 0;
      }
      // 新会话还没证明能播：稳定计时作废，否则上一会话的播放时长会被当成
      // 本会话的稳定依据，卡在 loading 的重建也能白拿预算重置。
      resumedAt = null;
      // 耗尽标记随会话更替解除（错误面板已被重建清掉，恢复判定该重新武装）；
      // 同 key 的预算沿用，保证「连续最多 N 次」的约束跨重建成立。
      exhausted = false;
    },
    endSession() {
      cancelTimer();
      activeSession = null;
    },
    notifyWaiting() {
      if (activeSession === null || exhausted || timerHandle !== null) return;
      const session = activeSession;
      const handle = clock.setTimer(() => {
        // 只清自己的句柄：可能已有更新一轮的计时挂在上面（过期回调迟到）。
        if (timerHandle === handle) timerHandle = null;
        // 计时属于已被替换/拆除的会话：作废，不对新会话动手。
        if (session !== activeSession) return;
        // 自上次恢复播放起稳定够久：这轮故障不是上一轮的延续，预算还回去。
        if (resumedAt !== null && clock.now() - resumedAt >= stableMs) autoRetries = 0;
        if (autoRetries >= maxAutoRetries) {
          exhausted = true;
          onExhausted();
          return;
        }
        autoRetries += 1;
        onAutoRetry();
      }, timeoutMs);
      timerHandle = handle;
    },
    notifyResumed() {
      cancelTimer();
      resumedAt = clock.now();
      // 视频自己缓过来也算恢复：之后再卡重新判定（重建次数仍受预算约束）。
      exhausted = false;
    },
    notifyPaused() {
      cancelTimer();
    },
    notifyEnded() {
      cancelTimer();
    },
    notifyError() {
      cancelTimer();
    },
    notifyManualRetry() {
      autoRetries = 0;
      exhausted = false;
      cancelTimer();
    },
  };
}
