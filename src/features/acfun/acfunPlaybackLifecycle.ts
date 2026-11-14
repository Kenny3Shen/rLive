import { PendingPlaybackRequests } from "@/features/shorts/pendingPlaybackRequests";
import type { AcfunVideoPlayInfo } from "./acfunTypes";

/** 查询数据携带发起时的内容身份，旧请求晚返回时不能交给当前播放器。 */
export type AcfunPlaybackResult = {
  key: string;
  info: AcfunVideoPlayInfo;
};

/**
 * AcFun VOD 播放代理的一份所有权。
 *
 * 在途和已返回但尚未接管的结果属于请求池，播放器展示中的结果属于 held。
 * Tauri invoke 不能被 AbortSignal 中止，因此被替换的请求返回后仍须释放自己的
 * 代理；旧结果也不能停止已经接管的新会话。
 */
export class AcfunPlaybackSessions {
  private readonly pending: PendingPlaybackRequests<AcfunPlaybackResult>;
  private held: AcfunPlaybackResult | null = null;
  private readonly retired = new Set<AcfunPlaybackResult>();
  private epoch = 0;

  constructor(private readonly stop: (sessionId: string) => void) {
    this.pending = new PendingPlaybackRequests((result) => {
      if (this.held?.info.session_id === result.info.session_id) return;
      if ([...this.retired].some((item) => item.info.session_id === result.info.session_id)) {
        return;
      }
      this.stop(result.info.session_id);
    });
  }

  acquire(
    key: string,
    signal: AbortSignal,
    request: () => Promise<AcfunVideoPlayInfo>,
  ): Promise<AcfunPlaybackResult> {
    const epoch = ++this.epoch;
    // 换稿件或画质后，上一轮尚未提交的结果不能与新请求争抢播放器。
    this.pending.clear();
    const cancelled = () => new DOMException("取流已取消", "AbortError");
    return this.pending
      .acquire(signal, async () => ({ key, info: await request() }))
      .then((result) => {
        // 请求落地后、查询提交前仍可能发生 clear/abort；所有权已经转移时不能提交。
        if (epoch !== this.epoch || signal.aborted || !this.pending.owns(result)) {
          throw cancelled();
        }
        return result;
      });
  }

  /** 播放器提交当前结果时接管；已被取消或清理的迟到结果返回 false。 */
  retain(result: AcfunPlaybackResult): boolean {
    if (!this.pending.claim(result)) return false;
    const previous = this.held;
    this.held = result;
    if (previous && previous.info.session_id !== result.info.session_id) {
      this.retired.add(previous);
    }
    return true;
  }

  /** 新播放器完成交接后释放旧代理，避免提前断开仍在清理的旧媒体。 */
  releasePrevious(): void {
    for (const previous of this.retired) {
      this.stop(previous.info.session_id);
    }
    this.retired.clear();
  }

  /** 离开当前稿件：在途结果迟到后由请求池释放，当前结果只停一次。 */
  clear(): void {
    this.epoch += 1;
    this.pending.clear();
    this.releasePrevious();
    const held = this.held;
    this.held = null;
    if (held) this.stop(held.info.session_id);
  }
}
