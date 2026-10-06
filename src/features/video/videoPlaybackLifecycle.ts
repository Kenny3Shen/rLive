import type { VideoHistoryItem, VideoPlayInfo, VideoSessionIds } from "@/shared/types/video";
import { PendingPlaybackRequests } from "@/features/shorts/pendingPlaybackRequests";

/** 查询数据必须携带发起时的内容身份，不能从当前路由或 query 状态反推。 */
export type VideoPlaybackResult = { key: string; info: VideoPlayInfo };

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

  constructor(private readonly stop: (ids: VideoSessionIds) => void) {
    this.pending = new PendingPlaybackRequests((result) => this.stop(result.info.session_ids));
  }

  acquire(
    key: string,
    signal: AbortSignal,
    request: () => Promise<VideoPlayInfo>,
  ): Promise<VideoPlaybackResult> {
    // 一页只有一条当前取流请求；已返回但尚未提交的旧结果也不能遗留到卸载。
    // 已 claim 的会话不在池内，换画质等待期间仍可继续播放。
    this.pending.clear();
    return this.pending.acquire(signal, async () => ({ key, info: await request() }));
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
    this.pending.clear();
    this.releasePrevious();
    const held = this.held;
    this.held = null;
    if (held) this.stop(held.info.session_ids);
  }
}

export type VideoResumeSnapshot = { key: string; position: number; playing: boolean };

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
