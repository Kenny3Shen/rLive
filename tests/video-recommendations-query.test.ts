import { QueryClient, InfiniteQueryObserver } from "@tanstack/query-core";
import { describe, expect, test } from "bun:test";
import { invalidateCookieDependentSiteQueries } from "../src/shared/api/cookieQueryInvalidation";
import type { VideoListPage } from "../src/shared/types/video";
import {
  VIDEO_RECOMMENDATION_FRESHNESS_MS,
  type RecommendationFeedData,
  type RecommendationFeedPage,
  isVideoRecommendationInvalidationEvent,
  recommendationNeedsRefresh,
  refreshRecommendationFirstPage,
  shouldRefreshRecommendationOnActivation,
  videoRecommendationQueryKey,
  videoRecommendationQueryOptions,
} from "../src/features/video/videoRecommendationsQuery";
import { deferred, settle } from "./helpers/async";
import { videoItem } from "./helpers/video";

function listPage(bvid: string, hasMore = true): VideoListPage {
  return {
    items: [videoItem({ bvid })],
    has_more: hasMore,
  };
}

function recommendationPage(
  bvid: string,
  fetchedAt: number,
  hasMore = true,
): RecommendationFeedPage {
  return { kind: "ugc", fetchedAt, ...listPage(bvid, hasMore) };
}

function twoPages(fetchedAt: number): RecommendationFeedData {
  return {
    pages: [
      recommendationPage("page1", fetchedAt),
      recommendationPage("page2", fetchedAt),
    ],
    pageParams: [1, 2],
  };
}

describe("VOD 推荐缓存年龄", () => {
  test("只有活动推荐页到期才触发，隐藏页签和后台文档不请求", () => {
    const now = 10 * VIDEO_RECOMMENDATION_FRESHNESS_MS;
    const data = twoPages(now - VIDEO_RECOMMENDATION_FRESHNESS_MS);
    const base = {
      enabled: true,
      pageVisible: true,
      documentVisible: true,
      data,
      dataUpdatedAt: now,
      invalidated: false,
      now,
    };

    expect(shouldRefreshRecommendationOnActivation(base)).toBe(true);
    expect(
      shouldRefreshRecommendationOnActivation({ ...base, pageVisible: false }),
    ).toBe(false);
    expect(
      shouldRefreshRecommendationOnActivation({ ...base, documentVisible: false }),
    ).toBe(false);
    expect(
      shouldRefreshRecommendationOnActivation({ ...base, enabled: false }),
    ).toBe(false);
    expect(
      recommendationNeedsRefresh(
        undefined,
        now - VIDEO_RECOMMENDATION_FRESHNESS_MS,
        now,
      ),
    ).toBe(false);
    expect(
      recommendationNeedsRefresh(
        { pages: [], pageParams: [] },
        now - VIDEO_RECOMMENDATION_FRESHNESS_MS,
        now,
      ),
    ).toBe(false);
    expect(
      recommendationNeedsRefresh(
        twoPages(now - VIDEO_RECOMMENDATION_FRESHNESS_MS + 1),
        now,
        now,
      ),
    ).toBe(false);
    expect(
      shouldRefreshRecommendationOnActivation({
        ...base,
        data: twoPages(now),
        invalidated: true,
      }),
    ).toBe(true);
  });

  test("翻页只更新 dataUpdatedAt，不延长首页年龄", async () => {
    const client = new QueryClient();
    let clock = 1_000;
    const observer = new InfiniteQueryObserver(
      client,
      videoRecommendationQueryOptions(
        "web",
        0,
        async (page) => listPage(page === 1 ? "page1" : "page2"),
        () => clock,
      ),
    );
    const unsubscribe = observer.subscribe(() => {});
    await settle();
    const first = observer.getCurrentResult().data as RecommendationFeedData;
    expect(first.pages[0].fetchedAt).toBe(1_000);

    clock = 2_000;
    await observer.fetchNextPage();
    const second = observer.getCurrentResult().data as RecommendationFeedData;
    expect(second.pages).toHaveLength(2);
    expect(second.pages[0].fetchedAt).toBe(1_000);
    expect(second.pages[1].fetchedAt).toBe(2_000);

    unsubscribe();
    client.clear();
  });

  test("当前推荐 key 在 TTL 内失效后仍进入首页刷新", async () => {
    const client = new QueryClient();
    const now = 10 * VIDEO_RECOMMENDATION_FRESHNESS_MS;
    const key = videoRecommendationQueryKey("app", 0);
    client.setQueryData<RecommendationFeedData>(key, twoPages(now - 1_000));
    client.setQueryData<RecommendationFeedData>(
      videoRecommendationQueryKey("app", 1),
      twoPages(now - 1_000),
    );
    let matchedInvalidations = 0;
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (isVideoRecommendationInvalidationEvent(event, "app", 0)) {
        matchedInvalidations += 1;
      }
    });

    await invalidateCookieDependentSiteQueries(client, "bilibili");
    const state = client.getQueryState<RecommendationFeedData>(key);
    expect(matchedInvalidations).toBe(1);
    expect(state?.isInvalidated).toBe(true);
    expect(
      shouldRefreshRecommendationOnActivation({
        enabled: true,
        pageVisible: true,
        documentVisible: true,
        data: state?.data,
        dataUpdatedAt: state?.dataUpdatedAt ?? 0,
        invalidated: state?.isInvalidated,
        now,
      }),
    ).toBe(true);

    unsubscribe();
    client.clear();
  });

  test("正常推荐补货和成功更新不会触发失效订阅", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new InfiniteQueryObserver(
      client,
      videoRecommendationQueryOptions("app", 0, async (page) =>
        listPage(`page-${page}`),
      ),
    );
    let matchedInvalidations = 0;
    const unsubscribeCache = client.getQueryCache().subscribe((event) => {
      if (isVideoRecommendationInvalidationEvent(event, "app", 0)) {
        matchedInvalidations += 1;
      }
    });
    const unsubscribeObserver = observer.subscribe(() => {});
    await settle();
    await observer.fetchNextPage();
    await settle();

    expect(matchedInvalidations).toBe(0);

    unsubscribeCache();
    unsubscribeObserver();
    client.clear();
  });
});

describe("VOD 推荐首页刷新", () => {
  test("刷新中保留全部旧页，成功后只留下新首页且并发调用共享请求", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = videoRecommendationQueryKey("app", 0);
    client.setQueryData<RecommendationFeedData>(key, twoPages(100));
    const next = deferred<VideoListPage>();
    const calls: number[] = [];
    const fetchPage = (page: number) => {
      calls.push(page);
      return next.promise;
    };

    const first = refreshRecommendationFirstPage(client, "app", 0, fetchPage);
    const second = refreshRecommendationFirstPage(client, "app", 0, fetchPage);
    await settle();

    expect(calls).toEqual([1]);
    expect(client.getQueryData<RecommendationFeedData>(key)?.pages).toHaveLength(2);
    next.resolve(listPage("fresh"));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(firstResult.pages).toHaveLength(1);
    expect(firstResult.pages[0].items[0].bvid).toBe("fresh");
    expect(firstResult.pages[0].fetchedAt).toBeGreaterThan(100);
    client.clear();
  });

  test("刷新失败保留旧多页并记录可重试错误", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = videoRecommendationQueryKey("app", 0);
    const old = twoPages(100);
    client.setQueryData<RecommendationFeedData>(key, old);
    const observer = new InfiniteQueryObserver(
      client,
      videoRecommendationQueryOptions("app", 0),
    );
    const unsubscribe = observer.subscribe(() => {});

    await expect(
      refreshRecommendationFirstPage(client, "app", 0, async () => {
        throw new Error("刷新失败");
      }),
    ).rejects.toThrow("刷新失败");
    expect(client.getQueryData<RecommendationFeedData>(key)).toEqual(old);
    expect(observer.getCurrentResult().isRefetchError).toBe(true);
    expect(client.getQueryCache().find({ queryKey: key })?.state.errorUpdatedAt).toBeGreaterThan(0);
    unsubscribe();
    client.clear();
  });

  test("取消旧补货后，迟到的旧页结果不能覆盖新首页", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const latePage2 = deferred<VideoListPage>();
    let firstPageCalls = 0;
    const fetchPage = (page: number) => {
      if (page === 1) {
        firstPageCalls += 1;
        return Promise.resolve(listPage(`fresh-${firstPageCalls}`));
      }
      return latePage2.promise;
    };
    const options = videoRecommendationQueryOptions("app", 0, fetchPage);
    const observer = new InfiniteQueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    await settle();

    const staleNextPage = observer.fetchNextPage().catch((error: unknown) => error);
    await settle();
    await refreshRecommendationFirstPage(client, "app", 0, fetchPage);
    latePage2.resolve(listPage("stale-page2"));
    await staleNextPage;
    await settle();

    const data = client.getQueryData<RecommendationFeedData>(
      videoRecommendationQueryKey("app", 0),
    );
    expect(firstPageCalls).toBe(2);
    expect(data?.pages).toHaveLength(1);
    expect(data?.pages[0].items[0].bvid).toBe("fresh-2");
    unsubscribe();
    client.clear();
  });

  test("推荐来源与授权版本使用独立缓存键和刷新", async () => {
    expect(videoRecommendationQueryKey("app", 1)).not.toEqual(
      videoRecommendationQueryKey("app", 2),
    );
    expect(videoRecommendationQueryKey("app", 1)).not.toEqual(
      videoRecommendationQueryKey("web", 1),
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const old = twoPages(100);
    client.setQueryData(videoRecommendationQueryKey("app", 1), old);
    client.setQueryData(videoRecommendationQueryKey("app", 2), old);
    await refreshRecommendationFirstPage(client, "app", 2, async (page) =>
      listPage(`account-2-page-${page}`),
    );
    expect(
      client.getQueryData<RecommendationFeedData>(
        videoRecommendationQueryKey("app", 1),
      )?.pages[0].items[0].bvid,
    ).toBe("page1");
    expect(
      client.getQueryData<RecommendationFeedData>(
        videoRecommendationQueryKey("app", 2),
      )?.pages[0].items[0].bvid,
    ).toBe("account-2-page-1");
    client.clear();
  });

  test("账号失效只标记推荐旧列表，首页刷新成功后再替换", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = videoRecommendationQueryKey("app", 0);
    const old = twoPages(100);
    client.setQueryData(key, old);

    await invalidateCookieDependentSiteQueries(client, "bilibili");
    expect(client.getQueryData<RecommendationFeedData>(key)).toEqual(old);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);

    await refreshRecommendationFirstPage(client, "app", 0, async (page) =>
      listPage(`fresh-${page}`),
    );
    expect(client.getQueryData<RecommendationFeedData>(key)?.pages).toHaveLength(1);
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    client.clear();
  });
});
