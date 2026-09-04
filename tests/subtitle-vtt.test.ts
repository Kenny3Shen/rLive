import { describe, expect, test } from "bun:test";
import { subtitleJsonToVtt } from "../src/features/video/subtitleVtt";

describe("subtitle json to vtt", () => {
  test("converts body lines into cues", () => {
    const vtt = subtitleJsonToVtt(
      JSON.stringify({
        body: [
          { from: 0, to: 1.5, content: "你好" },
          { from: 62.25, to: 64, content: "第二句" },
        ],
      }),
    );
    expect(vtt).toContain("WEBVTT");
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.500\n你好");
    expect(vtt).toContain("00:01:02.250 --> 00:01:04.000\n第二句");
  });

  test("skips invalid lines instead of failing the whole track", () => {
    const vtt = subtitleJsonToVtt(
      JSON.stringify({
        body: [
          { from: 1, to: 2, content: "ok" },
          { from: 2, to: 1, content: "时间倒置" },
          { from: 3, to: 4, content: "   " },
          { from: 5, to: 6 },
        ],
      }),
    );
    expect(vtt).toContain("ok");
    expect(vtt).not.toContain("时间倒置");
    expect(vtt.split("-->").length - 1).toBe(1);
  });

  test("returns empty for broken json", () => {
    expect(subtitleJsonToVtt("not json")).toBe("");
  });
});
