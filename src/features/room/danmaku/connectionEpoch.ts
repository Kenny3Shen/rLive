let latestEpoch = 0;

export type DanmakuConnectionFence = Readonly<{
  /** 停止下一次期望连接之前的所有活动内容。 */
  disconnectEpoch: number;
  /** 标识此后允许进入活动状态的连接。 */
  connectionEpoch: number;
}>;

/**
 * 为期望的弹幕连接生成应用级单调 token。
 *
 * 挂钟时间使 token 在前端重载后仍然有效，
 * 额外的自增保证同一毫秒内的快速路由切换有序。
 */
export function nextDanmakuConnectionEpoch(now = Date.now()): number {
  latestEpoch = Math.max(latestEpoch + 1, Math.floor(now));
  return latestEpoch;
}

/**
 * 为停止旧房间与连接其替代者保留各自的单调 token。携带较小 token 的延迟 stop
 * 在较大 token 的连接抵达原生后端之后就变得无害。
 */
export function nextDanmakuConnectionFence(now = Date.now()): DanmakuConnectionFence {
  const disconnectEpoch = nextDanmakuConnectionEpoch(now);
  return {
    disconnectEpoch,
    connectionEpoch: nextDanmakuConnectionEpoch(now),
  };
}
