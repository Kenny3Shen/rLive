import { describe, expect, test } from "bun:test";
import { chaptersToVtt } from "../src/features/video/chaptersVtt";

describe("点播章节 WebVTT", () => {
  test("无章节不生成轨道", () => {
    expect(chaptersToVtt(undefined)).toBe("");
    expect(chaptersToVtt([])).toBe("");
  });

  test("保留平台区间、空隙和标题，不补造前后章节", () => {
    expect(chaptersToVtt([
      { start_time: 5, end_time: 30.25, title: "开场" },
      { start_time: 40.5, end_time: 90, title: "演示" },
    ])).toBe("WEBVTT\n\n00:00:05.000 --> 00:00:30.250\n开场\n\n00:00:40.500 --> 00:01:30.000\n演示\n");
  });

  test("毫秒舍入正确跨分钟和小时，保留超过 24 小时的时间", () => {
    expect(chaptersToVtt([
      { start_time: 59.9999, end_time: 3599.9999, title: "进位" },
      { start_time: 3600, end_time: 90_000.125, title: "长视频" },
    ])).toContain("00:01:00.000 --> 01:00:00.000\n进位\n\n01:00:00.000 --> 25:00:00.125");
  });

  test("低于 WebVTT 精度的零长章节被跳过", () => {
    expect(chaptersToVtt([
      { start_time: 1.0001, end_time: 1.0002, title: "过短" },
    ])).toBe("");
  });

  test("标题换行和时间分隔符不能注入新 cue", () => {
    expect(chaptersToVtt([
      { start_time: 0, end_time: 10, title: "  开场\r\n\r\n00:01:00.000 --> 00:02:00.000\n标题  " },
    ])).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n开场 00:01:00.000 → 00:02:00.000 标题\n");
  });
});
