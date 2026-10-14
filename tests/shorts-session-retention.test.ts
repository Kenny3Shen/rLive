import { expect, test } from "bun:test";
import {
  SHORTS_RETENTION_EMPTY,
  shortsRetentionExpire,
  shortsRetentionPark,
  shortsRetentionPeek,
  shortsRetentionRelease,
} from "../src/features/shorts/shortsSessionRetention";

test.each([{ session_ids: { mpd: "dash-session" } }, { session_id: "native-session" }])(
  "保留位与媒体协议无关：只读查看、幂等放入及所有权移交 %j",
  (info) => {
    const { state } = shortsRetentionPark(SHORTS_RETENTION_EMPTY, "A", info, 1000);
    expect(shortsRetentionPeek(state, "A", 1001)).toBe(info);
    expect(shortsRetentionPeek(state, "A", 1002)).toBe(info);
    expect(shortsRetentionPeek(state, "B", 1002)).toBeNull();
    const again = shortsRetentionPark(state, "A", info, 5000);
    expect(again.state).toBe(state);
    expect(again.displaced).toBeNull();
    expect(state.parked?.parkedAtMs).toBe(1000);
    expect(shortsRetentionRelease(state, "B").state).toBe(state);
    const released = shortsRetentionRelease(state, "A");
    expect(released.released?.playInfo).toBe(info);
    expect(released.state).toBe(SHORTS_RETENTION_EMPTY);
    expect(shortsRetentionRelease(released.state, "A").released).toBeNull();
  },
);

test("K=1 顶替交出旧会话，TTL 从离开起算且只回收一次", () => {
  const first = shortsRetentionPark(SHORTS_RETENTION_EMPTY, "A", "session-A", 1000);
  const second = shortsRetentionPark(first.state, "B", "session-B", 2000);
  expect(second.displaced?.playInfo).toBe("session-A");
  expect(shortsRetentionPeek(second.state, "A", 2001)).toBeNull();
  expect(shortsRetentionPeek(second.state, "B", 16_999)).toBe("session-B");
  expect(shortsRetentionExpire(second.state, 16_999).state).toBe(second.state);
  // 后台定时器未执行时，取用也不得交出过期会话。
  expect(shortsRetentionPeek(second.state, "B", 17_000)).toBeNull();
  const expired = shortsRetentionExpire(second.state, 17_000);
  expect(expired.expired?.playInfo).toBe("session-B");
  expect(shortsRetentionExpire(expired.state, 18_000).expired).toBeNull();
});

test("A → B → A 先消费命中会话再保留离开的会话", () => {
  const first = shortsRetentionPark(SHORTS_RETENTION_EMPTY, "A", "session-A", 1000);
  const hit = shortsRetentionRelease(first.state, "A");
  expect(hit.released?.playInfo).toBe("session-A");
  const second = shortsRetentionPark(hit.state, "B", "session-B", 2000);
  expect(second.displaced).toBeNull();
  expect(shortsRetentionPeek(second.state, "B", 2500)).toBe("session-B");
});
