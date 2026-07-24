import { describe, expect, test } from "bun:test";
import { nextDanmakuConnectionEpoch } from "../src/features/room/danmaku/connectionEpoch";

describe("danmaku connection epochs", () => {
  test("stay strictly ordered for rapid route changes", () => {
    const first = nextDanmakuConnectionEpoch(1_000);
    const second = nextDanmakuConnectionEpoch(1_000);
    const third = nextDanmakuConnectionEpoch(999);

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});
