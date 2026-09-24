// F-02：关注刷新的部分成功摘要与失败项重试。
//
// 验收要求：10 个关注中 3 个超时，仍显示 7 个有效结果、3 个待确认及重试入口；
// 只重试那 3 个；失败不能把可用列表变成错误页，也不能把旧状态当成新确认。
import { describe, expect, test } from "bun:test";

import {
  applyRefreshResult,
  followKey,
  retryFailedFollows,
  summarizeRefresh,
  type FollowRefreshOutcome,
} from "../src/features/follow/followRefresh";
import type { FollowRefreshResult, FollowUser } from "../src/shared/types/live";

function follow(roomId: string, liveStatus: boolean | null, updatedAt = 1): FollowUser {
  return {
    site_id: "bilibili",
    room_id: roomId,
    user_name: `主播${roomId}`,
    face: "",
    tag_ids: [],
    auto_record: false,
    live_status: liveStatus,
    live_started_at: null,
    updated_at: updatedAt,
  };
}

function result(overrides: Partial<FollowRefreshResult["summary"]> = {}): FollowRefreshResult {
  return {
    follows: [follow("1", true), follow("2", false), follow("3", null)],
    summary: {
      total: 10,
      refreshed: 7,
      refreshed_keys: [followKey("bilibili", "1"), followKey("bilibili", "2")],
      failures: [
        {
          site_id: "bilibili",
          room_id: "3",
          user_name: "主播3",
          code: "bilibili_http_error",
          retryable: true,
        },
      ],
      checked_at: 1_700_000_000_000,
      ...overrides,
    },
  };
}

describe("关注刷新摘要", () => {
  test("区分已确认、失败与未参与三类条目", () => {
    const outcome = summarizeRefresh(result());

    // 已确认的才在 confirmed 集合里。
    expect(outcome.confirmed.has(followKey("bilibili", "1"))).toBe(true);
    expect(outcome.confirmed.has(followKey("bilibili", "2"))).toBe(true);
    expect(outcome.confirmed.has(followKey("bilibili", "3"))).toBe(false);

    // 失败项可直接用于定向重试，并带上名字便于展示。
    expect(outcome.failures).toEqual([
      { siteId: "bilibili", roomId: "3", userName: "主播3" },
    ]);
    expect(outcome.total).toBe(10);
    expect(outcome.checkedAt).toBe(1_700_000_000_000);
  });

  test("7 个成功 + 3 个失败时仍返回完整可用列表", () => {
    const follows = [
      ...Array.from({ length: 7 }, (_, index) => follow(`${index + 1}`, true)),
      ...Array.from({ length: 3 }, (_, index) => follow(`fail-${index}`, null)),
    ];
    const outcome = summarizeRefresh({
      follows,
      summary: {
        total: 10,
        refreshed: 7,
        refreshed_keys: follows.slice(0, 7).map((user) => followKey(user.site_id, user.room_id)),
        failures: follows.slice(7).map((user) => ({
          site_id: user.site_id,
          room_id: user.room_id,
          user_name: user.user_name,
          code: "bilibili_http_error",
          retryable: true,
        })),
        checked_at: 1,
      },
    });

    // 10 条全部保留（失败项显示上一轮结论），而不是被截成 7 条。
    expect(outcome.follows).toHaveLength(10);
    expect(outcome.confirmed.size).toBe(7);
    expect(outcome.failures).toHaveLength(3);
  });

  test("失败项列表可以原样交给定向重试", () => {
    const outcome = summarizeRefresh(result());
    // 只重试失败项，不重新探测整张列表。
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toEqual({
      siteId: "bilibili",
      roomId: "3",
      userName: "主播3",
    });
  });
});

describe("定向重试", () => {
  test("空目标不触发 IPC，直接返回空结果", async () => {
    // 没有失败项时点重试不应打网络。
    const outcome = await retryFailedFollows({} as never, []);
    expect(outcome.follows).toEqual([]);
    expect(outcome.failures).toEqual([]);
  });
});

describe("写回缓存", () => {
  test("把整表写回缓存，未参与条目保持不变", () => {
    const writes: unknown[] = [];
    const queryClient = {
      setQueryData: (_key: unknown, data: unknown) => writes.push(data),
    } as never;
    const follows = [follow("1", true), follow("2", false)];
    const outcome: FollowRefreshOutcome = {
      follows,
      confirmed: new Set([followKey("bilibili", "1")]),
      failures: [],
      checkedAt: 1,
      total: 2,
    };

    applyRefreshResult(queryClient, outcome);

    expect(writes).toEqual([follows]);
  });
});
