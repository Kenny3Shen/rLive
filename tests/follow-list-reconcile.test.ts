import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  FOLLOW_LIST_QUERY_KEY,
  mergeFollowList,
  resolveCachedFollows,
  subscribeToFollowListCache,
} from "../src/features/follow/followRefresh";
import type { FollowUser } from "../src/shared/types/live";

function follow(roomId: string, overrides: Partial<FollowUser> = {}): FollowUser {
  return {
    site_id: "bilibili",
    room_id: roomId,
    user_name: `主播${roomId}`,
    face: "",
    tag_ids: [],
    auto_record: false,
    live_status: true,
    live_started_at: null,
    updated_at: 1,
    ...overrides,
  };
}

describe("关注列表即时合并", () => {
  test("更新既有主播时保留顺序、分组及自动录制设置", () => {
    const first = follow("1", { auto_record: true, tag_ids: ["games"] });
    const second = follow("2");
    const submitted = follow("1", { user_name: "新名字", tag_ids: ["music"] });

    const result = mergeFollowList([first, second], "followed", submitted, submitted);

    expect(result?.map((item) => item.room_id)).toEqual(["1", "2"]);
    expect(result?.[0]).toMatchObject({
      user_name: "新名字",
      tag_ids: ["music"],
      auto_record: true,
    });
  });

  test("新关注追加、取消关注仅移除目标", () => {
    const first = follow("1");
    const second = follow("2");

    expect(
      mergeFollowList([first], "followed", second, second)?.map((item) => item.room_id),
    ).toEqual(["2", "1"]);
    expect(
      mergeFollowList([first, second], "unfollowed", first)?.map((item) => item.room_id),
    ).toEqual(["2"]);
  });

  test("缓存缺省时不伪造只有一条记录的全表", () => {
    expect(mergeFollowList(undefined, "followed", follow("1"), follow("1"))).toBeUndefined();
    expect(resolveCachedFollows(undefined)).toEqual([]);
  });

  test("共享缓存写入后，稳定订阅能读到同一份列表且引用不变", () => {
    const queryClient = new QueryClient();
    const list = [follow("1")];
    const events: number[] = [];
    const unsubscribe = subscribeToFollowListCache(queryClient, () => events.push(1));

    queryClient.setQueryData(FOLLOW_LIST_QUERY_KEY, undefined);
    queryClient.setQueryData(FOLLOW_LIST_QUERY_KEY, list);
    const first = resolveCachedFollows(queryClient.getQueryData(FOLLOW_LIST_QUERY_KEY));
    const second = resolveCachedFollows(queryClient.getQueryData(FOLLOW_LIST_QUERY_KEY));

    expect(first).toBe(list);
    expect(second).toBe(first);
    expect(events.length).toBeGreaterThan(0);
    const beforeUnsubscribe = events.length;
    unsubscribe();
    queryClient.setQueryData(FOLLOW_LIST_QUERY_KEY, [follow("2")]);
    expect(events).toHaveLength(beforeUnsubscribe);
  });
});
