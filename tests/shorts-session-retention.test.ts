import { describe, expect, test } from "bun:test";
import {
  SHORTS_RETENTION_EMPTY,
  SHORTS_SESSION_RETENTION_MS,
  shortsRetentionExpire,
  shortsRetentionExpired,
  shortsRetentionPark,
  shortsRetentionPeek,
  shortsRetentionRelease,
  shortsShouldRetainSession,
  type ShortsParkedSession,
  type ShortsRetentionState,
} from "../src/features/shorts/shortsSessionRetention";
import type { VideoPlayInfo } from "../src/shared/types/video";

/** 造一份 playInfo：`sessionIds.mpd` 是本次取流的身份。 */
function playInfo(mpd: string): VideoPlayInfo {
  return {
    mpd_url: `http://127.0.0.1/${mpd}`,
    video_url: "http://127.0.0.1/video",
    audio_url: "http://127.0.0.1/audio",
    duration: 60,
    quality: 112,
    quality_label: "1080P",
    codecs: "avc1.640033",
    accept_quality: [],
    session_ids: { video: `${mpd}-video`, audio: `${mpd}-audio`, mpd },
    audio_only: false,
  };
}

/** 放进一条并断言成功。 */
function park(
  state: ShortsRetentionState,
  key: string,
  mpd: string,
  nowMs: number,
): { state: ShortsRetentionState; displaced: ShortsParkedSession | null } {
  return shortsRetentionPark(state, key, playInfo(mpd), nowMs);
}

describe("保留策略", () => {
  test("只有用户真正看过的那条值得留", () => {
    // 预热过的没看过：它恰好又是新方向上的预热目标，两边都不值得留。
    expect(shortsShouldRetainSession(true)).toBe(true);
    expect(shortsShouldRetainSession(false)).toBe(false);
  });
});

describe("放入与查看", () => {
  test("放入后可以查到", () => {
    const { state } = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    expect(shortsRetentionPeek(state, "BV1_a", 1_000)?.session_ids.mpd).toBe("m1");
  });

  test("查看是只读的：多次查看结果一致", () => {
    // 渲染期会反复调用，非幂等会让会话被取走却没人用。
    const { state } = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    const first = shortsRetentionPeek(state, "BV1_a", 1_000);
    const second = shortsRetentionPeek(state, "BV1_a", 1_000);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    // 状态本身没被改动。
    expect(state.parked?.itemKey).toBe("BV1_a");
  });

  test("查别的条得到 null", () => {
    const { state } = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    expect(shortsRetentionPeek(state, "BV1_b", 1_000)).toBeNull();
  });

  test("K=1：放入新的会顶掉旧的，并把旧的交回调用方去停", () => {
    const first = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    const second = park(first.state, "BV1_b", "m2", 2_000);
    // 被顶掉的那条必须交回：它的三个回环监听器要有人停。
    expect(second.displaced?.itemKey).toBe("BV1_a");
    expect(second.displaced?.playInfo.session_ids.mpd).toBe("m1");
    expect(shortsRetentionPeek(second.state, "BV1_a", 2_000)).toBeNull();
    expect(shortsRetentionPeek(second.state, "BV1_b", 2_000)?.session_ids.mpd).toBe("m2");
  });

  test("同一条重复放入是幂等的，且不产生需要停的会话", () => {
    // 换片与角色变化两条路径都可能调它；重复停会打断正在播的那条。
    const first = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    const again = park(first.state, "BV1_a", "m1", 5_000);
    expect(again.state).toBe(first.state);
    expect(again.displaced).toBeNull();
    // 计时起点不因重复放入而顺延（否则 TTL 会被无限续期）。
    expect(again.state.parked?.parkedAtMs).toBe(1_000);
  });
});

describe("所有权移交", () => {
  test("移出后保留位为空，且把会话交回调用方", () => {
    const { state } = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    const released = shortsRetentionRelease(state, "BV1_a");
    expect(released.released?.itemKey).toBe("BV1_a");
    expect(released.state.parked).toBeNull();
    // 移出后查不到：所有权已经不在保留位了。
    expect(shortsRetentionPeek(released.state, "BV1_a", 1_000)).toBeNull();
  });

  test("重复移出是空操作（幂等）", () => {
    const { state } = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    const first = shortsRetentionRelease(state, "BV1_a");
    const second = shortsRetentionRelease(first.state, "BV1_a");
    expect(second.released).toBeNull();
    expect(second.state).toBe(first.state);
  });

  test("移出别的条不动保留位", () => {
    const { state } = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    const other = shortsRetentionRelease(state, "BV1_b");
    expect(other.released).toBeNull();
    expect(other.state).toBe(state);
  });
});

describe("TTL", () => {
  test("未到期不算过期，到期即过期", () => {
    expect(shortsRetentionExpired(1_000, 1_000, 15_000)).toBe(false);
    expect(shortsRetentionExpired(1_000, 15_999, 15_000)).toBe(false);
    expect(shortsRetentionExpired(1_000, 16_000, 15_000)).toBe(true);
    expect(shortsRetentionExpired(1_000, 30_000, 15_000)).toBe(true);
  });

  test("默认保留 15 秒", () => {
    expect(SHORTS_SESSION_RETENTION_MS).toBe(15_000);
  });

  test("到期的条目查不到 —— 后台标签页定时器被节流时的兜底", () => {
    const { state } = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    // 定时器没跑到，但取用时必须自己再判一次：否则会把一份指向已死会话的
    // playInfo 交出去。
    expect(shortsRetentionPeek(state, "BV1_a", 1_000 + 15_000)).toBeNull();
  });

  test("清理只回收已到期的，未到期的原样保留", () => {
    const { state } = park(SHORTS_RETENTION_EMPTY, "BV1_a", "m1", 1_000);
    const early = shortsRetentionExpire(state, 5_000, 15_000);
    expect(early.expired).toBeNull();
    expect(early.state).toBe(state);

    const late = shortsRetentionExpire(state, 16_000, 15_000);
    expect(late.expired?.itemKey).toBe("BV1_a");
    expect(late.state.parked).toBeNull();
  });

  test("空保留位清理是空操作", () => {
    const result = shortsRetentionExpire(SHORTS_RETENTION_EMPTY, 999_999, 15_000);
    expect(result.expired).toBeNull();
    expect(result.state).toBe(SHORTS_RETENTION_EMPTY);
  });
});

describe("往复滑动", () => {
  test("A→B→A：每次保留的正是下一次要回退到的那条", () => {
    // 这是 K=1 的结构性依据：一个保留位 + 一个预热槽位覆盖换片后的两个方向。
    //
    // 模型必须包含**消费**这一步：命中保留位时会话被 `release` 移出（所有权交给
    // 槽位），保留位随之空出，离开的那条再填进去。漏掉这一步的循环会误判失败。
    let state = SHORTS_RETENTION_EMPTY;
    const order = ["A", "B", "A", "B", "A"];
    for (let i = 0; i < order.length - 1; i += 1) {
      const leaving = order[i]!;
      const target = order[i + 1]!;
      const now = i * 1_000;
      // 换片：目标在保留位里就命中（省掉一次取流）。
      const hit = shortsRetentionPeek(state, target, now);
      if (hit) {
        state = shortsRetentionRelease(state, target).state;
      }
      // 无论命中与否，刚看过的 leaving 都进保留位，供下一次回退用。
      state = park(state, leaving, `m-${leaving}`, now).state;
      // 下一次回退到 leaving 时必然命中。
      expect(shortsRetentionPeek(state, leaving, now + 500), `第 ${i} 步：${leaving} 应被保留`).not.toBeNull();
    }
  });

  test("只往下刷：保留位始终是刚离开的那条，回退一次必命中", () => {
    // 顺向刷时每次都只有活动条被丢下（预热条刚好成为新的活动条），
    // 因此保留位覆盖的正是「回退一步」。
    let state = SHORTS_RETENTION_EMPTY;
    let now = 0;
    for (const leaving of ["A", "B", "C"]) {
      now += 1_000;
      state = park(state, leaving, `m-${leaving}`, now).state;
    }
    // 刚离开的是 C：回退到 C 命中（在 TTL 内）。
    expect(shortsRetentionPeek(state, "C", now + 5_000)).not.toBeNull();
    // 更早的 A、B 已被顶掉：K=1 的代价，连退两步不命中。
    expect(shortsRetentionPeek(state, "B", now + 5_000)).toBeNull();
    expect(shortsRetentionPeek(state, "A", now + 5_000)).toBeNull();
  });

  test("超过 TTL 的回退落空 —— 15s 的边界", () => {
    // TTL 的起点是「离开那条的时刻」，而回退通常发生在看完一段之后。
    const { state } = park(SHORTS_RETENTION_EMPTY, "A", "m-A", 1_000);
    expect(shortsRetentionPeek(state, "A", 1_000 + 14_999)).not.toBeNull();
    expect(shortsRetentionPeek(state, "A", 1_000 + 15_000)).toBeNull();
  });
});
