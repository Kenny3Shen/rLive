import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  invalidateCookieDependentSiteQueries,
  isCookieDependentSiteQuery,
} from "../src/shared/api/cookieQueryInvalidation";

describe("platform Cookie query invalidation", () => {
  test("recognizes only credential-dependent queries for the changed platform", () => {
    expect(isCookieDependentSiteQuery(["recommend", "douyin"], "douyin")).toBe(true);
    expect(isCookieDependentSiteQuery(["room_detail", "douyin", "123"], "douyin")).toBe(true);
    expect(isCookieDependentSiteQuery(["play_urls", "douyin", "123"], "douyin")).toBe(true);

    expect(isCookieDependentSiteQuery(["recommend", "bilibili"], "douyin")).toBe(false);
    expect(isCookieDependentSiteQuery(["follows"], "douyin")).toBe(false);
  });

  test("marks browse, room, and playback caches stale without touching other platforms", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const douyinRecommend = ["recommend", "douyin"];
    const douyinRoom = ["room_detail", "douyin", "123"];
    const douyinPlayback = ["play_urls", "douyin", "123", "high", "origin"];
    const bilibiliRecommend = ["recommend", "bilibili"];
    const follows = ["follows"];

    for (const key of [douyinRecommend, douyinRoom, douyinPlayback, bilibiliRecommend, follows]) {
      queryClient.setQueryData(key, { cached: true });
    }

    await invalidateCookieDependentSiteQueries(queryClient, "douyin");

    expect(queryClient.getQueryState(douyinRecommend)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(douyinRoom)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(douyinPlayback)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(bilibiliRecommend)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(follows)?.isInvalidated).toBe(false);
  });
});
