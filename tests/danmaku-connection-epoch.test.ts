import { describe, expect, test } from "bun:test";
import {
  nextDanmakuConnectionEpoch,
  nextDanmakuConnectionFence,
} from "../frontend/features/room/danmaku/connectionEpoch";

describe("danmaku connection epochs", () => {
  test("stay strictly ordered for rapid route changes", () => {
    const first = nextDanmakuConnectionEpoch(1_000);
    const second = nextDanmakuConnectionEpoch(1_000);
    const third = nextDanmakuConnectionEpoch(999);

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  test("uses a lower stop fence than its replacement connection", () => {
    const { disconnectEpoch, connectionEpoch } = nextDanmakuConnectionFence(2_000);
    const later = nextDanmakuConnectionEpoch(2_000);

    expect(connectionEpoch).toBeGreaterThan(disconnectEpoch);
    expect(later).toBeGreaterThan(connectionEpoch);
  });
});
