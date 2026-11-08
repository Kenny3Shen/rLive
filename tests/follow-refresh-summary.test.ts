// F-02：关注刷新的部分成功摘要与失败项重试。
//
// 验收要求：10 个关注中 3 个超时，仍保留全部 10 条列表，并单独给出 3 个失败项；
// 失败不能把可用列表变成错误页，没有失败项时不发起重试。
import { describe, expect, test } from "bun:test";
import {
  applyRefreshResult,
  retryFailedFollows,
  summarizeRefresh,
  type FollowRefreshOutcome,
} from "../src/features/follow/followRefresh";
import type { FollowUser } from "../src/shared/types/live";
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
describe("关注刷新摘要", () => {
  test("7 个成功 + 3 个失败时仍返回完整可用列表", () => {
    const follows = [
      ...Array.from(
        {
          length: 7,
        },
        (_, index) => follow(`${index + 1}`, true),
      ),
      ...Array.from(
        {
          length: 3,
        },
        (_, index) => follow(`fail-${index}`, null),
      ),
    ];
    const outcome = summarizeRefresh({
      follows,
      summary: {
        total: 10,
        refreshed: 7,
        refreshed_keys: follows.slice(0, 7).map((user) => `${user.site_id}:${user.room_id}`),
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
    expect(outcome.failures).toHaveLength(3);
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
      failures: [],
      total: 2,
    };
    applyRefreshResult(queryClient, outcome);
    expect(writes).toEqual([follows]);
  });
});
