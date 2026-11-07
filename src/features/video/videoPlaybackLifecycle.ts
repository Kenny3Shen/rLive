import type { VideoHistoryItem, VideoPlayInfo, VideoSessionIds } from "@/shared/types/video";
import { PendingPlaybackRequests } from "@/features/shorts/pendingPlaybackRequests";

/** 查询数据必须携带发起时的内容身份，不能从当前路由或 query 状态反推。 */
export type VideoPlaybackResult = { key: string; info: VideoPlayInfo };
/** 自动恢复取流落地时，旧播放器是否仍持有同一会话且已有可播数据。 */
export type VideoAutoRecoveryDecision = { keepHeld: boolean };
export type VideoAutoRecoveryCheck = (
  held: VideoPlaybackResult,
  fresh: VideoPlaybackResult | null,
) => VideoAutoRecoveryDecision | null;
/** 一轮取流的撤销判定，以及到达终态时同步结算该轮外部令牌。 */
export type VideoPlaybackAttempt = {
  autoRecoveryCheck?: VideoAutoRecoveryCheck;
  /** 正常成功、真实失败、取消和撤销都会结算本轮自动恢复令牌。 */
  onSettled?: () => void;
};

/** 当前播放器真正使用的地址：与重建时保存的地址比对，确认旧源没有被替换。 */
export function videoPlaybackSourceUrl(result: VideoPlaybackResult): string {
  return result.info.audio_only ? result.info.audio_url : result.info.mpd_url;
}

/** 媒体已有画面数据，且没有正在跳转、结束或原生错误。 */
export function hasPlayableAutoRecoveryData(
  media: Pick<HTMLMediaElement, "readyState" | "seeking" | "ended" | "error">,
): boolean {
  return media.readyState >= 2 && !media.seeking && !media.ended && media.error === null;
}

export function videoPlaybackForKey(
  result: VideoPlaybackResult | undefined,
  key: string,
): VideoPlayInfo | undefined {
  return result?.key === key ? result.info : undefined;
}

/**
 * VOD 页面的一份会话所有权：未提交结果属于请求池，提交后属于 held。
 * Tauri invoke 不支持真正取消，因此过期请求返回后仍须显式停掉代理。
 */
export class VideoPlaybackSessions {
  private readonly pending: PendingPlaybackRequests<VideoPlaybackResult>;
  private held: VideoPlaybackResult | null = null;
  private readonly retired = new Set<VideoPlaybackResult>();
  /** acquire/clear 都会作废旧轮次，迟到的结果或错误不能接管新会话。 */
  private epoch = 0;

  constructor(private readonly stop: (ids: VideoSessionIds) => void) {
    this.pending = new PendingPlaybackRequests((result) => this.stop(result.info.session_ids));
  }

  acquire(
    key: string,
    signal: AbortSignal,
    request: () => Promise<VideoPlayInfo>,
    attempt: VideoPlaybackAttempt = {},
  ): Promise<VideoPlaybackResult> {
    // 一页只有一条当前取流请求；已返回但尚未提交的旧结果也不能遗留到卸载。
    // 已 claim 的会话不在池内，换画质等待期间仍可继续播放。
    const epoch = ++this.epoch;
    this.pending.clear();
    const { autoRecoveryCheck, onSettled } = attempt;
    const cancelled = () => new DOMException("取流已取消", "AbortError");
    const requireCurrent = (): void => {
      if (epoch !== this.epoch || signal.aborted) throw cancelled();
    };
    const keepOwnedHeld = (fresh: VideoPlaybackResult | null): VideoPlaybackResult | null => {
      requireCurrent();
      // owner.clear() 或 query abort 可以在结果落地后、外层 then 运行前释放
      // 新代理并交走所有权。此后绝不能再把结果提交给播放器。
      if (fresh !== null && !this.pending.owns(fresh)) throw cancelled();
      const held = this.held;
      if (!autoRecoveryCheck || !held || held.key !== key) return null;
      const keepHeld = autoRecoveryCheck(held, fresh)?.keepHeld === true;
      // 回调可以同步清掉或替换 held；返回已释放的旧对象会让播放器接到断流。
      requireCurrent();
      if (fresh !== null && !this.pending.owns(fresh)) throw cancelled();
      if (this.held !== held) throw cancelled();
      if (!keepHeld) return null;
      if (fresh !== null) {
        // claim 失败说明请求已被 abort/clear 接管，释放逻辑已经执行过；
        // 不能再把 held 当成一次有效 query 成功结果提交。
        if (!this.pending.claim(fresh)) throw cancelled();
        this.stop(fresh.info.session_ids);
      }
      requireCurrent();
      if (this.held !== held) throw cancelled();
      return held;
    };
    return this.pending
      .acquire(signal, async () => ({ key, info: await request() }))
      .then(
        (result) => {
          try {
            // Tauri 请求不能中途取消。旧播放器已经缓过来时，释放刚建立的新代理，
            // 返回原 held 对象本身，让 query 的 data/source 保持完全不变。
            const held = keepOwnedHeld(result);
            return held ?? result;
          } finally {
            onSettled?.();
          }
        },
        (error: unknown) => {
          try {
            const name =
              typeof error === "object" && error !== null && "name" in error ? error.name : null;
            if (signal.aborted || name === "AbortError") throw error;
            // 自动恢复取流失败，但旧播放器此时已有可播数据：不必为一次无效的
            // 刷新弹出错误，继续沿用仍存活的旧代理。
            const held = keepOwnedHeld(null);
            if (!held) throw error;
            return held;
          } finally {
            onSettled?.();
          }
        },
      );
  }

  /** 当前由 layout 接管的会话；自动恢复用它核对 held 没有被卸载或换掉。 */
  heldResult(): VideoPlaybackResult | null {
    return this.held;
  }

  /** layout 提交时接管；query 的下一轮请求不能回收已显示的 placeholder。 */
  retain(result: VideoPlaybackResult): void {
    this.pending.claim(result);
    const previous = this.held;
    this.held = result;
    this.retired.delete(result);
    if (previous && previous.info.session_ids.mpd !== result.info.session_ids.mpd) {
      this.retired.add(previous);
    }
  }

  /** 在旧播放器 passive cleanup 完成后才停代理，不能抢在引擎销毁前断流。 */
  releasePrevious(): void {
    for (const previous of this.retired) this.stop(previous.info.session_ids);
    this.retired.clear();
  }

  clear(): void {
    this.epoch += 1;
    this.pending.clear();
    this.releasePrevious();
    const held = this.held;
    this.held = null;
    if (held) this.stop(held.info.session_ids);
  }
}

export type VideoResumeSnapshot = { key: string; position: number; playing: boolean };

/**
 * 一份快照是否属于当前内容。
 *
 * 只在「同一份内容重建播放器」（画质/仅音频/重试）时复用；换到别的视频后
 * 旧 key 的快照必须作废，否则上一集的卡顿现场（waiting）会被下一集当成续播点。
 */
export function resumeSnapshotFor(
  snapshot: VideoResumeSnapshot | null,
  key: string,
): VideoResumeSnapshot | null {
  return snapshot?.key === key ? snapshot : null;
}

/**
 * 一次快照请求是否该写进 `resumeAtRef`。
 *
 * 普通事件（timeupdate/waiting/pause）只认「全局内容键仍是本轮」：内容切走后
 * 迟到的旧会话事件不能污染下一轮。会话 cleanup 是终点的例外 —— 换视频时布局
 * 阶段已经把全局键指向新视频，若在这里拦下，离开前的位置就永远不会落进快照。
 */
export function shouldCaptureResume(
  currentKey: string,
  sessionKey: string,
  closing: boolean,
): boolean {
  return closing || currentKey === sessionKey;
}

/**
 * 只用已建立的媒体位置覆盖快照。初始化失败时的 0 秒不是新断点；
 * 真正就绪后用户 seek 到 0 则是有效选择，必须允许覆盖原来的历史位置。
 */
export function videoPlaybackSnapshot(
  previous: VideoResumeSnapshot | null,
  key: string,
  media: Pick<HTMLMediaElement, "currentTime" | "paused">,
  positionReady: boolean,
): VideoResumeSnapshot | null {
  if (!positionReady || !Number.isFinite(media.currentTime) || media.currentTime < 0) {
    return previous;
  }
  return { key, position: media.currentTime, playing: !media.paused };
}

/** 同一分集的元数据可补全；换集不能覆盖旧实例 cleanup 所需的历史条目。 */
export class VideoPlaybackHistory {
  entry: VideoHistoryItem | null = null;

  constructor(private readonly cid: number) {}

  update(entry: VideoHistoryItem | null): void {
    if (entry?.cid === this.cid) this.entry = entry;
  }
}
