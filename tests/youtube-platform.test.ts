import { describe, expect, test } from "bun:test";
import { shouldProxyHost } from "../src/shared/api/imageProxy";
import { isDirectRoomInput } from "../src/features/search/search";
import {
  LIVE_SITE_IDS,
  enabledSiteIds,
  isSiteId,
  updateDisabledSiteIds,
} from "../src/shared/siteId";

describe("YouTube 平台入口", () => {
  test("YouTube 是默认启用且可单独停用的已知平台", () => {
    expect(isSiteId("youtube")).toBe(true);
    expect(LIVE_SITE_IDS).toContain("youtube");
    expect(enabledSiteIds([])).toContain("youtube");

    const disabled = updateDisabledSiteIds([], "youtube", false);
    expect(disabled).toContain("youtube");
    expect(enabledSiteIds(disabled)).not.toContain("youtube");
    expect(updateDisabledSiteIds(disabled, "youtube", true)).not.toContain("youtube");
  });

  test("YouTube 图片 CDN 仅按主机边界进入代理", () => {
    expect(shouldProxyHost("i.ytimg.com")).toBe(true);
    expect(shouldProxyHost("yt3.ggpht.com")).toBe(true);
    expect(shouldProxyHost("lh3.googleusercontent.com")).toBe(true);
    expect(shouldProxyHost("youtube.com")).toBe(false);
    expect(shouldProxyHost("youtu.be")).toBe(false);
    expect(shouldProxyHost("ytimg.com.evil.invalid")).toBe(false);
  });

  test("房间号模式放行 YouTube 标识、频道与直播链接", () => {
    expect(isDirectRoomInput("youtube", "dQw4w9WgXcQ")).toBe(true);
    expect(isDirectRoomInput("youtube", "@SomeChannel")).toBe(true);
    expect(isDirectRoomInput("youtube", "@SomeChannel/live")).toBe(true);
    expect(isDirectRoomInput("youtube", "https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(
      isDirectRoomInput("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBe(true);
    expect(isDirectRoomInput("youtube", "youtube.com/channel/UCAbCdEfGhIjKlMnOpQrStUv/live")).toBe(
      true,
    );
    expect(isDirectRoomInput("youtube", "channel/UCAbCdEfGhIjKlMnOpQrStUv/live")).toBe(true);
    expect(isDirectRoomInput("youtube", "普通搜索词")).toBe(false);
    expect(isDirectRoomInput("bilibili", "12345")).toBe(true);
  });
});
