import { describe, expect, test } from "bun:test";
import { filterIptvChannels, getIptvGroupOptions } from "../frontend/features/iptv/filterChannels";
import type { IptvChannel } from "../frontend/features/iptv/types";

function channel(id: string, name: string, group: string): IptvChannel {
  return {
    id,
    name,
    group,
    logo: null,
    url: `https://media.example.test/${id}.m3u8`,
    headers: {},
  };
}

const channels = [
  channel("cctv-news", "CCTV News", "新闻"),
  channel("cctv-hd", "CCTV News HD", "新闻"),
  channel("finance", "CCTV 财经", "综合"),
  channel("world-news", "World News", "新闻"),
];

describe("IPTV channel filters", () => {
  test("orders groups by their channel count", () => {
    expect(getIptvGroupOptions(channels)).toEqual([
      { value: "新闻", count: 3 },
      { value: "综合", count: 1 },
    ]);
  });

  test("requires every search term and ranks exact names first", () => {
    expect(
      filterIptvChannels(channels, { group: "all", query: "CCTV 新闻" }).map((item) => item.id),
    ).toEqual(["cctv-news", "cctv-hd"]);
    expect(
      filterIptvChannels(channels, { group: "all", query: "ＣＣＴＶ" }).map((item) => item.id),
    ).toEqual(["cctv-news", "cctv-hd", "finance"]);
  });

  test("combines the category and keyword filters", () => {
    expect(
      filterIptvChannels(channels, { group: "新闻", query: "news" }).map((item) => item.id),
    ).toEqual(["cctv-news", "cctv-hd", "world-news"]);
  });

  test("splits a source's semicolon-separated categories for filtering", () => {
    const multiCategoryChannel = channel(
      "discovering-china",
      "Discovering China",
      "Culture;Documentary",
    );
    const options = getIptvGroupOptions([multiCategoryChannel]);

    expect(options).toEqual([
      { value: "Culture", count: 1 },
      { value: "Documentary", count: 1 },
    ]);
    expect(
      filterIptvChannels([multiCategoryChannel], { group: "Documentary", query: "culture" }),
    ).toEqual([multiCategoryChannel]);
  });
});
