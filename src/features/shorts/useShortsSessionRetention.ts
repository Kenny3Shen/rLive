import { useCallback, useEffect, useRef, useState } from "react";
import { videoStopPlay } from "@/features/video/videoApi";
import type { VideoPlayInfo } from "@/shared/types/video";
import {
  SHORTS_RETENTION_EMPTY,
  SHORTS_SESSION_RETENTION_MS,
  shortsRetentionExpire,
  shortsRetentionPark,
  shortsRetentionPeek,
  shortsRetentionRelease,
  type ShortsParkedSession,
  type ShortsRetentionState,
} from "./shortsSessionRetention";

/**
 * 保留位的命令式外壳：独占状态、一个定时器，以及**停会话**这个副作用。
 *
 * 纯状态迁移都在 `shortsSessionRetention.ts`（可单测）；这里只做四件事：
 *
 * 1. 一个定时器负责 TTL 到期时停掉保留的会话。
 * 2. 被顶掉 / 到期 / 卸载时调 `videoStopPlay` —— 保留会话是**本机资源**，每留
 *    一条就多三个回环监听器，泄漏的代价是持续的。
 * 3. 取用时再确认一次 TTL：后台标签页的定时器会被浏览器节流，不能只靠它。
 * 4. 渲染期只提供 `peek`（只读），真正的所有权移交由 effect 里的 `release` 做 ——
 *    渲染可能被 React 丢弃，在渲染期做非幂等操作会把会话取走却没人用。
 *
 * 放在页面层而不是槽位 hook 里：被保留的条目在换片后**不属于任何一个槽位**
 * （两个槽位被新活动条与新预热条占着）。
 */
export type ShortsSessionRetention = {
  /** 只读查看：这一条是否有可复用的会话（渲染期安全）。 */
  peek: (itemKey: string) => VideoPlayInfo | null;
  /** 把会话移出保留位交给槽位，**不停它**（effect 里调，幂等）。 */
  release: (itemKey: string) => void;
  /** 放入保留位；会停掉被顶掉的那条。 */
  park: (itemKey: string, playInfo: VideoPlayInfo) => void;
};

export function useShortsSessionRetention(
  ttlMs: number = SHORTS_SESSION_RETENTION_MS,
): ShortsSessionRetention {
  const [state, setState] = useState<ShortsRetentionState>(SHORTS_RETENTION_EMPTY);
  // 定时器与回调要读最新状态，而状态更新是异步的：用一个镜像 ref 给它们读。
  const stateRef = useRef(state);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** 停掉一条保留会话（本机资源，必须显式释放）。 */
  const stop = useCallback((parked: ShortsParkedSession | null) => {
    if (parked) void videoStopPlay(parked.playInfo.session_ids);
  }, []);

  const commit = useCallback((next: ShortsRetentionState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /** 到期处理：停会话并清空保留位。定时器与取用路径共用。 */
  const expireNow = useCallback(() => {
    const { state: next, expired } = shortsRetentionExpire(stateRef.current, Date.now(), ttlMs);
    if (!expired) return;
    clearTimer();
    commit(next);
    stop(expired);
  }, [clearTimer, commit, stop, ttlMs]);

  const peek = useCallback(
    (itemKey: string): VideoPlayInfo | null =>
      shortsRetentionPeek(stateRef.current, itemKey, Date.now(), ttlMs),
    [ttlMs],
  );

  const release = useCallback(
    (itemKey: string) => {
      const { state: next, released } = shortsRetentionRelease(stateRef.current, itemKey);
      // 没命中就是空操作，也不动定时器。
      if (!released) return;
      clearTimer();
      commit(next);
      // 刻意不停：所有权已交给槽位，由它的 `heldRef` 交接路径负责存亡。
    },
    [clearTimer, commit],
  );

  const park = useCallback(
    (itemKey: string, playInfo: VideoPlayInfo) => {
      const { state: next, displaced } = shortsRetentionPark(
        stateRef.current,
        itemKey,
        playInfo,
        Date.now(),
      );
      // 同一条重复放入：不动状态，也不重启定时器。
      if (next === stateRef.current) return;
      clearTimer();
      commit(next);
      stop(displaced);
      timerRef.current = window.setTimeout(expireNow, ttlMs);
    },
    [clearTimer, commit, expireNow, stop, ttlMs],
  );

  // 卸载兜底：页面离开后不该还常驻三个回环监听器。
  useEffect(
    () => () => {
      clearTimer();
      const parked = stateRef.current.parked;
      if (parked) void videoStopPlay(parked.playInfo.session_ids);
    },
    [clearTimer],
  );

  return { peek, release, park };
}
