import { QueryClient } from "@tanstack/query-core";
import { describe, expect, test } from "bun:test";
import type { LiveRoomItem, RoomListPage } from "../src/shared/types/live";
import {
  roomCoverSnapshot,
  roomCoverVersions,
  type RoomCoverSnapshot,
} from "../src/shared/api/roomCoverSnapshot";
import { buildProxyTarget } from "../src/shared/api/imageProxy";

function room(roomId: string): LiveRoomItem {
  return {
    site_id: "twitch",
    room_id: roomId,
    title: roomId,
    cover: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${roomId}.jpg`,
    user_name: roomId,
    online: 1,
  };
}

function page(...roomIds: string[]): RoomListPage {
  return { items: roomIds.map(room), has_more: true };
}

type CoverQueryData = {
  pages: RoomCoverSnapshot[];
  pageParams: number[];
};

describe("直播列表封面快照", () => {
  test("缓存命中沿用同一版本，分页只给新增页生成版本", () => {
    const client = new QueryClient();
    const key = ["recommend", "twitch", 0];
    const firstPage = roomCoverSnapshot(page("alpha", "shared"));
    client.setQueryData<CoverQueryData>(key, { pages: [firstPage], pageParams: [1] });

    const cached = client.getQueryData<CoverQueryData>(key)!;
    expect(roomCoverVersions(cached.pages).get("twitch:alpha")).toBe(firstPage.coverRevision);

    const secondPage = roomCoverSnapshot(page("beta", "shared"));
    client.setQueryData<CoverQueryData>(key, {
      pages: [...cached.pages, secondPage],
      pageParams: [...cached.pageParams, 2],
    });

    const appended = client.getQueryData<CoverQueryData>(key)!;
    expect(appended.pages[0]).toBe(firstPage);
    expect(roomCoverVersions(appended.pages)).toEqual(
      new Map([
        ["twitch:alpha", firstPage.coverRevision],
        ["twitch:shared", firstPage.coverRevision],
        ["twitch:beta", secondPage.coverRevision],
      ]),
    );
    client.clear();
  });

  test("重新抓取相同数据会生成新版本，使固定 URL 封面显式刷新", () => {
    const client = new QueryClient();
    const key = ["category_rooms", "twitch", "all", "live"];
    const first = roomCoverSnapshot(page("alpha"));
    client.setQueryData<CoverQueryData>(key, { pages: [first], pageParams: [1] });

    const refreshed = roomCoverSnapshot(page("alpha"));
    client.setQueryData<CoverQueryData>(key, { pages: [refreshed], pageParams: [1] });

    const data = client.getQueryData<CoverQueryData>(key)!;
    expect(data.pages[0].items).toEqual(first.items);
    expect(data.pages[0].coverRevision).not.toBe(first.coverRevision);
    client.clear();
  });
});

describe("直播封面代理请求", () => {
  const base = "http://127.0.0.1:51234";
  const cover = "https://static-cdn.jtvnw.net/previews-ttv/live_user_alpha.jpg";

  test("快照版本只作为本机 HTTP 缓存键，不改变上游地址", () => {
    const first = buildProxyTarget(base, cover, {
      cache: false,
      coverRevision: "snapshot 1",
    });
    const repeated = buildProxyTarget(base, cover, {
      cache: false,
      coverRevision: "snapshot 1",
    });
    const refreshed = buildProxyTarget(base, cover, {
      cache: false,
      coverRevision: "snapshot 2",
    });

    expect(first).toBe(
      `${base}/img?nocache=1&revision=snapshot%201&url=${encodeURIComponent(cover)}`,
    );
    expect(repeated).toBe(first);
    expect(refreshed).not.toBe(first);
  });

  test("没有快照版本的封面继续使用短缓存请求", () => {
    expect(buildProxyTarget(base, cover, { cache: false })).toBe(
      `${base}/img?nocache=1&url=${encodeURIComponent(cover)}`,
    );
  });
});
