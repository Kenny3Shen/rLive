import { InfiniteQueryObserver, QueryClient } from "@tanstack/query-core";
import { describe, expect, test } from "bun:test";
import type { InfiniteData } from "@tanstack/react-query";
import {
  homeCategoryRoomsQueryOptions,
  homeQueryIsActive,
  homeRecommendationsQueryOptions,
  refreshCategoryRoomsFirstPage,
  refreshHomeRecommendationsFirstPage,
  waitForHomeRefreshScroll,
} from "../src/features/home/homeQuery";
import type { LiveRoomItem, RoomListPage } from "../src/shared/types/live";
import { deferred, settle } from "./helpers/async";

function room(id: string): LiveRoomItem {
  return {
    site_id: "bilibili",
    room_id: id,
    title: id,
    cover: `https://example.com/${id}.jpg`,
    user_name: id,
    online: 1,
  };
}

function page(id: string, hasMore = true): RoomListPage {
  return { has_more: hasMore, items: [room(id)] };
}

function pages(ids: readonly string[]): InfiniteData<RoomListPage, number> {
  return {
    pages: ids.map((id, index) => page(id, index < ids.length - 1)),
    pageParams: ids.map((_, index) => index + 1),
  };
}

describe("直播首页刷新", () => {
  test("多页刷新只替换首页，并发刷新共享请求，之后还能继续分页", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const firstPage = deferred<RoomListPage>();
    const calls: number[] = [];
    const fetchPage = (pageParam: number) => {
      calls.push(pageParam);
      return pageParam === 1 ? firstPage.promise : Promise.resolve(page("page-2"));
    };
    const options = homeRecommendationsQueryOptions("bilibili", 0, fetchPage);
    const old = pages(["old-1", "old-2", "old-3"]);
    client.setQueryData<InfiniteData<RoomListPage, number>>(options.queryKey, old);
    const observer = new InfiniteQueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    await settle();

    const first = refreshHomeRecommendationsFirstPage(client, "bilibili", 0, fetchPage);
    const second = refreshHomeRecommendationsFirstPage(client, "bilibili", 0, fetchPage);
    await settle();

    expect(calls).toEqual([1]);
    expect(client.getQueryData<InfiniteData<RoomListPage, number>>(options.queryKey)).toEqual(old);

    firstPage.resolve(page("fresh-1"));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(firstResult.pages.map((item) => item.items[0]?.room_id)).toEqual(["fresh-1"]);
    expect(calls).toEqual([1]);

    const next = await observer.fetchNextPage();
    expect(calls).toEqual([1, 2]);
    expect(next.data?.pages.map((item) => item.items[0]?.room_id)).toEqual(["fresh-1", "page-2"]);

    unsubscribe();
    client.clear();
  });

  test("失败保留旧多页，查询回到idle并可重试", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const options = homeRecommendationsQueryOptions("bilibili", 0, async () => {
      throw new Error("刷新失败");
    });
    const old = pages(["old-1", "old-2"]);
    client.setQueryData<InfiniteData<RoomListPage, number>>(options.queryKey, old);
    const observer = new InfiniteQueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    await settle();

    const refreshing = refreshHomeRecommendationsFirstPage(client, "bilibili", 0, async () => {
      throw new Error("刷新失败");
    });
    await expect(refreshing).rejects.toThrow("刷新失败");

    expect(client.getQueryData<InfiniteData<RoomListPage, number>>(options.queryKey)).toEqual(old);
    expect(client.getQueryState(options.queryKey)?.fetchStatus).toBe("idle");
    expect(observer.getCurrentResult().isRefetchError).toBe(true);

    await refreshHomeRecommendationsFirstPage(client, "bilibili", 0, async () =>
      page("fresh-retry", false),
    );
    expect(
      client.getQueryData<InfiniteData<RoomListPage, number>>(options.queryKey)?.pages[0]?.items[0]
        ?.room_id,
    ).toBe("fresh-retry");
    expect(client.getQueryState(options.queryKey)?.fetchStatus).toBe("idle");
    expect(observer.getCurrentResult().isSuccess).toBe(true);

    unsubscribe();
    client.clear();
  });

  test("旧页迟到不能覆盖新首页，之后可以获取新的下一页", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stalePage = deferred<RoomListPage>();
    let pageOneCalls = 0;
    let pageTwoCalls = 0;
    const fetchPage = (pageParam: number) => {
      if (pageParam === 1) {
        pageOneCalls += 1;
        return Promise.resolve(page(`page-1-${pageOneCalls}`));
      }
      pageTwoCalls += 1;
      return pageTwoCalls === 1 ? stalePage.promise : Promise.resolve(page("fresh-page-2"));
    };
    const options = homeRecommendationsQueryOptions("bilibili", 0, fetchPage);
    const observer = new InfiniteQueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    await settle();

    const staleNextPage = observer.fetchNextPage().then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();
    expect(pageTwoCalls).toBe(1);

    await refreshHomeRecommendationsFirstPage(client, "bilibili", 0, fetchPage);
    stalePage.resolve(page("stale-page-2"));
    await staleNextPage;
    await settle();

    const afterRefresh = client.getQueryData<InfiniteData<RoomListPage, number>>(options.queryKey);
    expect(afterRefresh?.pages.map((item) => item.items[0]?.room_id)).toEqual(["page-1-2"]);

    const next = await observer.fetchNextPage();
    expect(pageTwoCalls).toBe(2);
    expect(next.data?.pages.map((item) => item.items[0]?.room_id)).toEqual([
      "page-1-2",
      "fresh-page-2",
    ]);

    unsubscribe();
    client.clear();
  });

  test("分区列表刷新沿用原缓存键并只请求首页", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const category = { id: "33", name: "分区", parent_id: "1", pic: null };
    const options = homeCategoryRoomsQueryOptions("bilibili", category);
    client.setQueryData<InfiniteData<RoomListPage, number>>(
      options.queryKey,
      pages(["old-1", "old-2", "old-3"]),
    );
    const calls: number[] = [];

    await refreshCategoryRoomsFirstPage(client, "bilibili", category, async (pageParam) => {
      calls.push(pageParam);
      return page("fresh-category", false);
    });

    const data = client.getQueryData<InfiniteData<RoomListPage, number>>(options.queryKey);
    expect(calls).toEqual([1]);
    expect(data?.pages.map((item) => item.items[0]?.room_id)).toEqual(["fresh-category"]);
    client.clear();
  });

  test("只剩当前 query 活动时才允许成功刷新复位页面", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const recommend = homeRecommendationsQueryOptions("bilibili", 0, async () => page("fresh"));
    const category = homeCategoryRoomsQueryOptions(
      "bilibili",
      {
        id: "33",
        name: "分区",
        parent_id: "1",
        pic: null,
      },
      async () => page("fresh-category"),
    );
    const observer = new InfiniteQueryObserver(client, recommend);
    const unsubscribe = observer.subscribe(() => {});
    await settle();
    expect(homeQueryIsActive(client, recommend.queryKey)).toBe(true);
    expect(homeQueryIsActive(client, category.queryKey)).toBe(false);

    observer.setOptions(category);
    expect(homeQueryIsActive(client, recommend.queryKey)).toBe(false);
    expect(homeQueryIsActive(client, category.queryKey)).toBe(true);

    unsubscribe();
    client.clear();
  });

  test("刷新等到回顶帧完成，旧页尾哨兵在成功响应与回顶之间保持暂停", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const options = homeRecommendationsQueryOptions("bilibili", 0, async () => page("fresh"));
    const observer = new InfiniteQueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    await settle();

    let frame: (() => void) | undefined;
    let scrollToTopCalls = 0;
    let completed = false;
    const completion = waitForHomeRefreshScroll(
      client,
      options.queryKey,
      (callback) => {
        frame = callback;
      },
      () => {
        scrollToTopCalls += 1;
      },
    ).then(() => {
      completed = true;
    });

    await settle();
    expect(frame).toBeFunction();
    expect(completed).toBe(false);
    expect(scrollToTopCalls).toBe(0);

    frame?.();
    await completion;
    expect(completed).toBe(true);
    expect(scrollToTopCalls).toBe(1);

    unsubscribe();
    client.clear();
  });

  test("刷新发起后视图已失活时不再安排回顶", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const options = homeRecommendationsQueryOptions("bilibili", 0, async () => page("fresh"));
    let scheduled = false;
    let scrolled = false;

    await waitForHomeRefreshScroll(
      client,
      options.queryKey,
      () => {
        scheduled = true;
      },
      () => {
        scrolled = true;
      },
    );

    expect(scheduled).toBe(false);
    expect(scrolled).toBe(false);
    client.clear();
  });
});
