import { describe, expect, test } from "bun:test";
import { buildProxyTarget } from "../src/shared/api/imageProxy";

const BASE = "http://127.0.0.1:51234";
const COVER = "https://live-cover.msstatic.com/huyalive/1-imgplus/20260821200348.jpg";

describe("image proxy cover targets", () => {
  test("keeps avatars on the cached path", () => {
    expect(buildProxyTarget(BASE, "https://i0.hdslb.com/bfs/face/a.jpg")).toBe(
      `${BASE}/img?url=${encodeURIComponent("https://i0.hdslb.com/bfs/face/a.jpg")}`,
    );
  });

  test("marks covers as no-cache so timestamped URLs never reach the disk cache", () => {
    expect(buildProxyTarget(BASE, COVER, { cache: false })).toBe(
      `${BASE}/img?nocache=1&url=${encodeURIComponent(COVER)}`,
    );
  });

  test("encodes the upstream URL so its query cannot inject proxy flags", () => {
    const target = buildProxyTarget(BASE, "https://i0.hdslb.com/a.jpg?x=1&nocache=1");
    expect(target.startsWith(`${BASE}/img?url=`)).toBe(true);
    expect(target.includes("&nocache=1")).toBe(false);
  });
});
