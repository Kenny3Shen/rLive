import { describe, expect, test } from "bun:test";
import {
  directPlayerPath,
  iptvHomePath,
  iptvPlayerPath,
  iptvReturnPathFromState,
} from "../src/features/iptv/iptvRoute";
import {
  iptvFavoriteSourceId,
  iptvFavoriteSourceIdFromRoute,
  playlistSourceForFavorite,
  playlistSourceFromRoute,
  playlistSourcesForSettings,
} from "../src/features/iptv/playlistSource";

describe("IPTV routes", () => {
  test("keeps discovery filters in a shareable path without exposing a custom source URL", () => {
    const source = playlistSourceFromRoute("custom", "https://example.test/list.m3u");
    expect(
      iptvHomePath({
        source,
        group: "News",
        query: "CCTV HD",
      }),
    ).toBe("/iptv?source=custom&group=News&q=CCTV+HD");
    expect(
      iptvPlayerPath({
        source,
        channelUrl: "https://media.example.test/live.m3u8",
      }),
    ).toBe("/iptv/play?channel=https%3A%2F%2Fmedia.example.test%2Flive.m3u8&source=custom");
  });

  test("omits default discovery filters and encodes the player identity", () => {
    expect(iptvHomePath({ group: "all", query: "  " })).toBe("/iptv");
    const source = playlistSourceFromRoute("chinese", null);
    expect(
      iptvPlayerPath({
        source,
        channelUrl: "https://media.example.test/live.m3u8?token=a&b=c",
      }),
    ).toBe(
      "/iptv/play?channel=https%3A%2F%2Fmedia.example.test%2Flive.m3u8%3Ftoken%3Da%26b%3Dc&source=chinese",
    );
  });

  test("builds a reload-safe direct playback route without losing URL tokens", () => {
    const directUrl = "https://cdn.example/live.m3u8?token=a+b&part=1#segment";
    const route = directPlayerPath({ directUrl });

    expect(new URLSearchParams(route.split("?", 2)[1]).get("direct")).toBe(directUrl);
  });

  test("resolves only supported built-in and legacy custom sources", () => {
    expect(playlistSourceFromRoute("mainland", null).label).toBe("中国大陆");
    expect(playlistSourceFromRoute("custom", "https://example.test/custom.m3u").url).toBe(
      "https://example.test/custom.m3u",
    );
    expect(playlistSourceFromRoute("custom", "file:///private.m3u").id).toBe("chinese");
  });

  test("builds the shared source options from local custom-source settings", () => {
    expect(
      playlistSourcesForSettings("https://example.test/custom.m3u").map(({ id }) => id),
    ).toEqual(["chinese", "mainland", "east-asia", "general", "custom"]);
    expect(playlistSourcesForSettings("file:///private.m3u").map(({ id }) => id)).toEqual([
      "chinese",
      "mainland",
      "east-asia",
      "general",
    ]);
  });

  test("separates custom-source favorites without exposing the M3U address", () => {
    const first = playlistSourceFromRoute("custom", "https://example.test/first.m3u");
    const second = playlistSourceFromRoute("custom", "https://example.test/second.m3u");

    expect(iptvFavoriteSourceId(first)).toMatch(/^custom:[0-9a-f]{8}$/);
    expect(iptvFavoriteSourceId(first)).not.toContain(first.url);
    expect(iptvFavoriteSourceId(first)).not.toBe(iptvFavoriteSourceId(second));
    expect(iptvFavoriteSourceId(playlistSourceFromRoute("mainland", null))).toBe("mainland");
  });

  test("opens a stored custom favorite snapshot without exposing its playlist", () => {
    const source = playlistSourceForFavorite("custom:1234abcd", null);

    expect(
      iptvPlayerPath({
        source,
        channelUrl: "https://media.example.test/live.m3u8",
        favoriteSourceId: "custom:1234abcd",
      }),
    ).toBe(
      "/iptv/play?channel=https%3A%2F%2Fmedia.example.test%2Flive.m3u8&source=custom&favoriteSource=custom%3A1234abcd",
    );
    expect(source.url).toBe("");
  });

  test("validates compact favorite source references from player routes", () => {
    expect(iptvFavoriteSourceIdFromRoute(" custom:1234abcd ")).toBe("custom:1234abcd");
    expect(iptvFavoriteSourceIdFromRoute(" ")).toBeNull();
    expect(iptvFavoriteSourceIdFromRoute("x".repeat(65))).toBeNull();
  });

  test("accepts only supported local pages as player return targets", () => {
    expect(iptvReturnPathFromState({ returnTo: "/iptv?group=News" })).toBe("/iptv?group=News");
    expect(iptvReturnPathFromState({ returnTo: "/follow?view=iptv" })).toBe("/follow?view=iptv");
    expect(iptvReturnPathFromState({ returnTo: "/settings?section=network" })).toBe(
      "/settings?section=network",
    );
    expect(iptvReturnPathFromState({ returnTo: "/room/bilibili/1" })).toBeNull();
    expect(iptvReturnPathFromState({ returnTo: "https://example.test/iptv" })).toBeNull();
  });
});
