import { describe, expect, test } from "bun:test";
import {
  iptvFavoritesQueryKey,
  iptvFavoritesForSource,
  mergeFavoriteChannels,
  resolveIptvChannel,
  setFavoriteGroupInList,
  sortIptvFavoriteGroups,
  type IptvFavorite,
} from "../src/features/iptv/favorites";
import type { IptvChannel } from "../src/features/iptv/types";

function channel(url: string, name: string): IptvChannel {
  return {
    id: name,
    name,
    group: "新闻",
    logo: null,
    url,
    protocol: "hls",
    headers: {},
  };
}

function favorite(url: string, name: string, updatedAt: number): IptvFavorite {
  return {
    ...channel(url, name),
    source_id: "chinese",
    favorite_group_id: null,
    updated_at: updatedAt,
  };
}

describe("IPTV favorites", () => {
  test("uses the current playlist metadata for followed channels", () => {
    const url = "https://media.example.test/news.m3u8";
    const current = channel(url, "CCTV 新闻（新版）");
    const result = mergeFavoriteChannels([current], [favorite(url, "CCTV 新闻（旧快照）", 20)]);

    expect(result).toEqual([current]);
  });

  test("keeps stored snapshots when a followed channel leaves the playlist", () => {
    const currentUrl = "https://media.example.test/current.m3u8";
    const removedUrl = "https://media.example.test/removed.m3u8";
    const removed = favorite(removedUrl, "已移除频道", 20);

    expect(
      mergeFavoriteChannels(
        [channel(currentUrl, "当前频道")],
        [removed, favorite(currentUrl, "当前频道旧快照", 10)],
      ),
    ).toEqual([removed, channel(currentUrl, "当前频道")]);
  });

  test("scopes query caches by playlist source", () => {
    expect(iptvFavoritesQueryKey("chinese")).toEqual(["iptv_favorites", "chinese"]);
    expect(iptvFavoritesQueryKey("custom")).toEqual(["iptv_favorites", "custom"]);
  });

  test("filters the combined follow list by the Shell source", () => {
    const chinese = favorite("https://media.example.test/chinese.m3u8", "中文频道", 2);
    const mainland = {
      ...favorite("https://media.example.test/mainland.m3u8", "大陆频道", 1),
      source_id: "mainland",
    };

    expect(iptvFavoritesForSource([chinese, mainland], "mainland")).toEqual([mainland]);
  });

  test("player prefers current metadata and falls back to a stored snapshot", () => {
    const url = "https://media.example.test/news.m3u8";
    const snapshot = favorite(url, "旧快照", 10);
    const current = channel(url, "当前频道");

    expect(resolveIptvChannel(url, [current], [snapshot])).toBe(current);
    expect(resolveIptvChannel(url, [], [snapshot])).toBe(snapshot);
    expect(
      resolveIptvChannel("https://media.example.test/missing.m3u8", [], [snapshot]),
    ).toBeNull();
  });

  test("sorts custom groups and updates only the matching favorite", () => {
    expect(
      sortIptvFavoriteGroups([
        { id: "10", name: "频道10" },
        { id: "2", name: "频道2" },
      ]),
    ).toEqual([
      { id: "2", name: "频道2" },
      { id: "10", name: "频道10" },
    ]);

    const first = favorite("https://media.example.test/first.m3u8", "一台", 2);
    const second = favorite("https://media.example.test/second.m3u8", "二台", 1);
    expect(setFavoriteGroupInList([first, second], first, "news")).toEqual([
      { ...first, favorite_group_id: "news" },
      second,
    ]);
  });
});
