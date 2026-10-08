import { describe, expect, test } from "bun:test";
import { chaptersToVtt } from "../src/features/video/chaptersVtt";
import { activeChapterIndex, playableChapters } from "../src/features/video/videoChapters";

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

describe("点播章节菜单", () => {
  const chapters = [
    { start_time: 0, end_time: 120, title: "开场" },
    { start_time: 180, end_time: 300, title: "演示" },
    { start_time: 300, end_time: 900, title: "总结" },
  ];

  test("剔除零长、非有限值与越过实际时长的章节", () => {
    expect(playableChapters(undefined, 600)).toEqual([]);
    expect(
      playableChapters(
        [
          ...chapters,
          { start_time: 50, end_time: 50, title: "零长" },
          { start_time: Number.NaN, end_time: 10, title: "无效" },
          { start_time: 650, end_time: 700, title: "越界" },
        ],
        600,
      ).map((chapter) => chapter.title),
    ).toEqual(["开场", "演示", "总结"]);
  });

  test("时长未知时不按时长裁剪", () => {
    expect(playableChapters(chapters, 0)).toHaveLength(3);
    expect(playableChapters(chapters, Number.NaN)).toHaveLength(3);
  });

  test("当前章节按区间判定，间隙不沿用上一章", () => {
    expect(activeChapterIndex(chapters, 0)).toBe(0);
    expect(activeChapterIndex(chapters, 119.9)).toBe(0);
    expect(activeChapterIndex(chapters, 150)).toBe(-1);
    expect(activeChapterIndex(chapters, 180)).toBe(1);
    // 相邻区间的边界归后一章。
    expect(activeChapterIndex(chapters, 300)).toBe(2);
    expect(activeChapterIndex(chapters, 900)).toBe(-1);
    expect(activeChapterIndex([], 10)).toBe(-1);
  });

  test("区间重叠时取起点较晚的一章", () => {
    expect(
      activeChapterIndex(
        [
          { start_time: 0, end_time: 100, title: "长章" },
          { start_time: 40, end_time: 60, title: "插入" },
        ],
        50,
      ),
    ).toBe(1);
  });
});
