import { describe, expect, test } from "bun:test";
import { commentTimestampSegments } from "../src/features/video/commentTimestamp";

const timestamps = (text: string) =>
  commentTimestampSegments(text).filter((segment) => segment.kind === "timestamp");

describe("评论空降时间戳", () => {
  test("支持分秒、时分秒、全角冒号与零秒", () => {
    expect(timestamps("开场0:00，精彩01:23，结尾1:02:03，全角１２不识别 02：34")).toEqual([
      { kind: "timestamp", text: "0:00", seconds: 0 },
      { kind: "timestamp", text: "01:23", seconds: 83 },
      { kind: "timestamp", text: "1:02:03", seconds: 3723 },
      { kind: "timestamp", text: "02：34", seconds: 154 },
    ]);
  });

  test("分钟可超过 59，重复时间与连续中文不丢失", () => {
    expect(timestamps("空降123:45再看123:45").map((segment) => segment.seconds)).toEqual([
      7425, 7425,
    ]);
  });

  test("非法格式不能从后缀误提取时间", () => {
    for (const text of [
      "1:99",
      "1:60:23",
      "1:2:03",
      "1:02:3",
      "1:02:03:04",
      "1::02:03",
      "1:234",
      "1:2",
    ]) {
      expect(timestamps(text)).toEqual([]);
    }
  });

  test("不拆开编号、小数或路径，拒绝不安全的整数", () => {
    for (const text of [
      "abc01:23",
      "01:23xyz",
      "1.01:23",
      "01:23.45",
      "/01:23/",
      "9999999999999999999:00",
    ]) {
      expect(timestamps(text)).toEqual([]);
    }
  });

  test("无时间戳、空正文、换行和标点保持原样", () => {
    for (const text of [
      "",
      "纯文本[大哭]",
      "00:00开始\n1:23 高能！\n1:99非法 2：03结尾",
      "00:00-01:00",
    ]) {
      expect(
        commentTimestampSegments(text)
          .map((segment) => segment.text)
          .join(""),
      ).toBe(text);
    }
    expect(timestamps("00:00-01:00").map((segment) => segment.seconds)).toEqual([0, 60]);
  });
});
