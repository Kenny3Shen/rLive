import { afterEach, describe, expect, test } from "bun:test";
import type { VirtualItem } from "@tanstack/react-virtual";
import {
  HISTORY_LIVE_EDGE_THRESHOLD_PX,
  HISTORY_SCROLL_SNAPSHOT_LIMIT,
  DANMAKU_CARD_ESTIMATE_PX,
  DANMAKU_CONTENT_MAX_HEIGHT_PX,
  clearHistoryScrollSnapshots,
  historyAnchorTo,
  historySnapshotKey,
  readHistoryScrollSnapshot,
  registerHistoryRefreshScrollReset,
  resetHistoryScrollForRefresh,
  saveHistoryScrollSnapshot,
  type HistoryScrollSnapshot,
} from "../src/features/history/historyVirtual";

/** 造一条形态合法的测量，内容无所谓：LRU 只按键淘汰，不看测量值。 */
const measurement = (index: number): VirtualItem => ({
  key: `row-${index}`,
  index,
  start: index * 100,
  end: index * 100 + 100,
  size: 100,
  lane: 0,
});

const snapshotOf = (offset: number): HistoryScrollSnapshot => ({
  measurements: [measurement(0)],
  offset,
});

// 快照存在模块级 Map 里，跨用例共享；每个用例前清空，断言才不受上一条影响。
afterEach(clearHistoryScrollSnapshots);

describe("history scroll snapshot store", () => {
  test("reads back what was written, keyed independently", () => {
    saveHistoryScrollSnapshot("a", snapshotOf(120));
    saveHistoryScrollSnapshot("b", snapshotOf(340));

    expect(readHistoryScrollSnapshot("a")?.offset).toBe(120);
    expect(readHistoryScrollSnapshot("b")?.offset).toBe(340);
    expect(readHistoryScrollSnapshot("missing")).toBeNull();
  });

  test("overwrites in place instead of accumulating", () => {
    saveHistoryScrollSnapshot("a", snapshotOf(120));
    saveHistoryScrollSnapshot("a", snapshotOf(999));

    expect(readHistoryScrollSnapshot("a")?.offset).toBe(999);
  });

  test("ignores empty keys", () => {
    saveHistoryScrollSnapshot("", snapshotOf(120));
    expect(readHistoryScrollSnapshot("")).toBeNull();
  });

  test("clear empties the store", () => {
    saveHistoryScrollSnapshot("a", snapshotOf(120));
    clearHistoryScrollSnapshots();
    expect(readHistoryScrollSnapshot("a")).toBeNull();
  });

  test("evicts the oldest entry once past the limit", () => {
    for (let index = 0; index < HISTORY_SCROLL_SNAPSHOT_LIMIT; index += 1) {
      saveHistoryScrollSnapshot(`key-${index}`, snapshotOf(index));
    }
    // 再写一条越界：最旧的 key-0 应被淘汰，其余保留。
    saveHistoryScrollSnapshot("overflow", snapshotOf(-1));

    expect(readHistoryScrollSnapshot("key-0")).toBeNull();
    expect(readHistoryScrollSnapshot("key-1")?.offset).toBe(1);
    expect(readHistoryScrollSnapshot("overflow")?.offset).toBe(-1);
  });

  test("overwriting refreshes recency, sparing a key from eviction", () => {
    for (let index = 0; index < HISTORY_SCROLL_SNAPSHOT_LIMIT; index += 1) {
      saveHistoryScrollSnapshot(`key-${index}`, snapshotOf(index));
    }
    // 覆盖最旧的一条应把它移到末尾；下一次越界改淘汰 key-1。
    saveHistoryScrollSnapshot("key-0", snapshotOf(1000));
    saveHistoryScrollSnapshot("overflow", snapshotOf(-1));

    expect(readHistoryScrollSnapshot("key-0")?.offset).toBe(1000);
    expect(readHistoryScrollSnapshot("key-1")).toBeNull();
  });
});

describe("historyAnchorTo", () => {
  test("does not anchor at or within the live-edge threshold", () => {
    expect(historyAnchorTo(0)).toBe("start");
    expect(historyAnchorTo(HISTORY_LIVE_EDGE_THRESHOLD_PX)).toBe("start");
  });

  test("anchors to end once scrolled past the threshold", () => {
    expect(historyAnchorTo(HISTORY_LIVE_EDGE_THRESHOLD_PX + 1)).toBe("end");
    expect(historyAnchorTo(4000)).toBe("end");
  });
});

describe("historySnapshotKey", () => {
  test("combines entry key and view without colliding across views", () => {
    const keys = new Set([
      historySnapshotKey("abc123", "watch"),
      historySnapshotKey("abc123", "video"),
      historySnapshotKey("abc123", "danmaku"),
    ]);
    expect(keys.size).toBe(3);
    expect(historySnapshotKey("abc123", "watch")).toBe("abc123:watch");
  });

  test("separates the same view across different history entries", () => {
    expect(historySnapshotKey("abc123", "watch")).not.toBe(historySnapshotKey("def456", "watch"));
  });

  test("is deterministic for the same inputs", () => {
    expect(historySnapshotKey("k", "video")).toBe(historySnapshotKey("k", "video"));
  });
});

describe("history refresh scroll reset", () => {
  test("invokes every registered reset for a non-zero token", () => {
    let calls = 0;
    registerHistoryRefreshScrollReset(7, () => {
      calls += 1;
    });
    registerHistoryRefreshScrollReset(8, () => {
      calls += 10;
    });

    resetHistoryScrollForRefresh(7);
    expect(calls).toBe(11);
  });

  test("replaces a token's reset on re-registration and drops it on unregister", () => {
    let first = 0;
    let second = 0;
    registerHistoryRefreshScrollReset(8, () => {
      first += 1;
    });
    // 同一令牌再次登记＝替换：一条时间线只保留自己最近登记的回调。
    registerHistoryRefreshScrollReset(8, () => {
      second += 1;
    });
    resetHistoryScrollForRefresh(8);
    expect([first, second]).toEqual([0, 1]);

    // 传 null 即撤销登记（卸载路径）。
    registerHistoryRefreshScrollReset(8, null);
    resetHistoryScrollForRefresh(8);
    expect(second).toBe(1);
  });

  test("resets every registered timeline, not just one token", () => {
    // 三个视图共用同一个滚动容器，因此刷新要归零的是「这个容器」而不是某一条
    // 时间线：只要有一条登记在册，回顶就应当发生。
    let watch = 0;
    let danmaku = 0;
    registerHistoryRefreshScrollReset(10, () => {
      watch += 1;
    });
    registerHistoryRefreshScrollReset(11, () => {
      danmaku += 1;
    });

    resetHistoryScrollForRefresh(10);
    expect([watch, danmaku]).toEqual([1, 1]);
  });

  test("ignores the zero token, which means 'not participating'", () => {
    let calls = 0;
    registerHistoryRefreshScrollReset(0, () => {
      calls += 1;
    });
    resetHistoryScrollForRefresh(0);
    expect(calls).toBe(0);
  });

  test("clear drops both snapshots and pending resets", () => {
    saveHistoryScrollSnapshot("a", snapshotOf(120));
    registerHistoryRefreshScrollReset(9, () => undefined);
    clearHistoryScrollSnapshots();

    expect(readHistoryScrollSnapshot("a")).toBeNull();
    // 清表后令牌不再有登记者。
    let calls = 0;
    registerHistoryRefreshScrollReset(9, () => {
      calls += 1;
    });
    resetHistoryScrollForRefresh(9);
    expect(calls).toBe(1);
  });
});

describe("danmaku card sizing", () => {
  test("estimate is not below the clamped card height", () => {
    // 窗口化列表的总高度 = 已测行实测高 + 未测行估高。实测发生在行进入视口时，
    // 因此实测一旦系统性超过估高，往下滚就会持续把总高度往上抬：滚动条比滚动
    // 更快变长，表现为「怎么也滚不到底」。浏览器夹具实测（400 行、长内容）：
    // 不限高 + 估高 132 → 214 步里 211 步增长（总高 +61%）；限高 + 170 → 0 步。
    expect(DANMAKU_CARD_ESTIMATE_PX).toBeGreaterThanOrEqual(DANMAKU_CONTENT_MAX_HEIGHT_PX);
  });
});
