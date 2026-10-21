import { describe, expect, test } from "bun:test";
import { softSwitchOwnsTransport } from "../src/features/room/player/softSwitchTransaction";

/** 软切期间被事务认领的错误不再另外发布给恢复会话。 */
function publishesToRecovery(
  transaction: { player: unknown; sequence: number } | null,
  player: unknown,
): boolean {
  return !softSwitchOwnsTransport(transaction, player);
}

describe("软切事务的错误归属", () => {
  test("事务登记后同一播放器的错误由 switchSource 认领，不再二次上报", () => {
    const player = { id: "player" };
    const transaction = { player, sequence: 1 };
    expect(softSwitchOwnsTransport(transaction, player)).toBe(true);
    expect(publishesToRecovery(transaction, player)).toBe(false);
  });

  test("事务结算或取消后错误恢复为正常上报", () => {
    const player = { id: "player" };
    expect(publishesToRecovery(null, player)).toBe(true);
    expect(publishesToRecovery({ player, sequence: 2 }, { id: "replacement" })).toBe(true);
  });

  test("事务只认领自己那个播放器", () => {
    const player = { id: "player" };
    const transaction = { player, sequence: 3 };
    expect(softSwitchOwnsTransport(transaction, { id: "player" })).toBe(false);
    expect(softSwitchOwnsTransport(transaction, null)).toBe(false);
  });
});
