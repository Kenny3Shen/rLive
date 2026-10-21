/**
 * 一次软切事务的身份。
 *
 * 软切在 `stream_proxy_start` 之前就登记，覆盖「旧传输仍在、新传输尚未建立」
 * 的整段准备期，直到 `switchSource` 结算或被取消。
 */
export type SoftSwitchTransaction = {
  player: unknown;
  sequence: number;
};

/**
 * 这次传输失败是否已被软切事务认领。
 *
 * 认领期内 `switchSource` 的 error 监听会把本次切换 reject 出去，由既有硬回退
 * 统一重建；同一失败若再发布给恢复会话，会同时触发一次续期与一次硬重建。只在
 * 事务属于同一个播放器时成立：其他播放器（例如已被替换的旧实例）的错误照常上报。
 */
export function softSwitchOwnsTransport(
  transaction: SoftSwitchTransaction | null,
  player: unknown,
): boolean {
  return transaction !== null && transaction.player === player;
}
