import { describe, expect, test } from "bun:test";
import {
  iptvHomePath,
  iptvPlayerPath,
  iptvReturnPathFromState,
} from "../src/features/iptv/iptvRoute";
import { playlistSourceFromRoute } from "../src/features/iptv/playlistSource";

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

  test("resolves only supported built-in and legacy custom sources", () => {
    expect(playlistSourceFromRoute("mainland", null).label).toBe("中国大陆");
    expect(playlistSourceFromRoute("custom", "https://example.test/custom.m3u").url).toBe(
      "https://example.test/custom.m3u",
    );
    expect(playlistSourceFromRoute("custom", "file:///private.m3u").id).toBe("chinese");
  });

  test("accepts only the IPTV discovery page as a player return target", () => {
    expect(iptvReturnPathFromState({ returnTo: "/iptv?group=News" })).toBe("/iptv?group=News");
    expect(iptvReturnPathFromState({ returnTo: "/room/bilibili/1" })).toBeNull();
    expect(iptvReturnPathFromState({ returnTo: "https://example.test/iptv" })).toBeNull();
  });
});
