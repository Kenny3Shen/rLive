import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IptvPlayer } from "../src/features/iptv/IptvPlayer";
import type { IptvChannel } from "../src/features/iptv/types";

const CHANNEL: IptvChannel = {
  id: "news-one",
  name: "新闻频道",
  group: "新闻",
  logo: null,
  url: "https://example.com/live.m3u8",
  protocol: "hls",
  headers: {},
};

describe("shared media lifecycle interface", () => {
  test("renders the IPTV adapter through the shared player refs and controls", () => {
    const html = renderToStaticMarkup(
      React.createElement(IptvPlayer, { channel: CHANNEL, reloadToken: 0 }),
    );

    expect(html).toContain("data-iptv-player-stage");
    expect(html).toContain("data-player-engine-root");
    expect(html).toContain("data-player-video");
    expect(html).toContain("data-player-hud");
    expect(html).toContain("data-[visible=false]:opacity-0");
    expect(html).toContain("新闻频道");
  });

  test("keeps an empty IPTV adapter idle without creating a transport source", () => {
    const html = renderToStaticMarkup(
      React.createElement(IptvPlayer, { channel: null, reloadToken: 0 }),
    );

    expect(html).toContain("从右侧频道列表选择节目");
    expect(html).toContain("data-player-video");
  });
});
