import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

function renderIptv(channel: IptvChannel | null): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  try {
    return renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(IptvPlayer, { channel, reloadToken: 0 }),
      ),
    );
  } finally {
    queryClient.clear();
  }
}

describe("shared media lifecycle interface", () => {
  test("renders the IPTV adapter through the shared player refs and controls", () => {
    const html = renderIptv(CHANNEL);

    expect(html).toContain("data-iptv-player-stage");
    expect(html).toContain("data-player-engine-root");
    expect(html).toContain("data-player-video");
    expect(html).toContain("data-player-hud");
    expect(html).toContain("data-[visible=false]:opacity-0");
    expect(html).toContain("新闻频道");
  });

  test("keeps an empty IPTV adapter idle without creating a transport source", () => {
    const html = renderIptv(null);

    expect(html).toContain("从右侧频道列表选择节目");
    expect(html).toContain("data-player-video");
  });
});
