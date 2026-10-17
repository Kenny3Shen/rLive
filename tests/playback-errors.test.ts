import { describe, expect, test } from "bun:test";
import {
  videoJsPlaybackErrorSeverity,
  videoJsRecoverableErrorMessage,
} from "../src/features/room/player/videoJsPlayer";
import {
  errorPresentation,
  errorMessageLooksTechnical,
} from "../src/shared/components/errorPresentation";
import { shortsPlaybackError } from "../src/features/shorts/shortsPlaybackError";

describe("引擎错误分级", () => {
  test("dash.js 的分片/sidx/时间同步按可恢复处理", () => {
    for (const code of [15, 16, 17, 18, 21, 22, 26, 27, 33]) {
      expect(videoJsPlaybackErrorSeverity({ code, message: "segment" })).toBe("recoverable");
    }
  });

  test("manifest、init 段、原生 MediaError 与未知错误按致命处理", () => {
    // 25 = manifest、28 = init 段：没有可播内容；1~4 是原生 MediaError。
    for (const code of [10, 11, 12, 20, 25, 28, 29, 31, 32, 34, 1, 2, 3, 4]) {
      expect(videoJsPlaybackErrorSeverity({ code })).toBe("fatal");
    }
    expect(videoJsPlaybackErrorSeverity(new Error("decode"))).toBe("fatal");
    expect(videoJsPlaybackErrorSeverity(null)).toBe("fatal");
    expect(videoJsPlaybackErrorSeverity("boom")).toBe("fatal");
  });

  test("hls.js 的 fatal 布尔优先于数值 code", () => {
    expect(videoJsPlaybackErrorSeverity({ fatal: false, code: 25 })).toBe("recoverable");
    expect(videoJsPlaybackErrorSeverity({ fatal: true, code: 27 })).toBe("fatal");
  });

  test("包了一层的错误（video.js 事件载荷）按内层分类", () => {
    expect(videoJsPlaybackErrorSeverity({ error: { code: 27 } })).toBe("recoverable");
    expect(videoJsPlaybackErrorSeverity({ error: { code: 25 } })).toBe("fatal");
  });

  test("可恢复提示区分字幕轨与分片", () => {
    expect(videoJsRecoverableErrorMessage({ code: 33 })).toContain("字幕");
    expect(videoJsRecoverableErrorMessage({ code: 27 })).toContain("分片");
    expect(videoJsRecoverableErrorMessage(null)).toContain("分片");
  });
});

describe("错误呈现", () => {
  test("HTML、URL、HTTP 状态与堆栈只进技术详情", () => {
    for (const message of [
      "HTTP 412 Precondition Failed: <!DOCTYPE html><html></html>",
      "failed to fetch https://api.bilibili.com/x/v2/reply",
      "TypeError: Cannot read properties of undefined",
      "at async fetchPlayInfo (src/features/video/videoApi.ts:1:1)",
    ]) {
      expect(errorMessageLooksTechnical(message)).toBe(true);
      const presentation = errorPresentation({ code: "bilibili_http_error", message });
      expect(presentation.description).not.toContain("<");
      expect(presentation.description).not.toContain("http");
      expect(presentation.technical).toContain(message);
      expect(presentation.technical).toContain("bilibili_http_error");
    }
  });

  test("可读的业务短句原样作为说明", () => {
    const presentation = errorPresentation({ code: "video_error", message: "该视频没有声音" });
    expect(presentation.description).toBe("该视频没有声音");
    expect(presentation.technical).toBe("video_error: 该视频没有声音");
  });

  test("超长文案退回通用说明，原始内容仍可展开", () => {
    const message = "请求失败".repeat(60);
    const presentation = errorPresentation(message);
    expect(presentation.description).not.toBe(message);
    expect(presentation.technical).toBe(message);
  });

  test("空错误不留空白的技术详情", () => {
    expect(errorPresentation(null)).toEqual({
      description: expect.any(String),
      technical: null,
    });
    expect(errorPresentation({ code: "x" }).technical).toBe("x");
  });
});

describe("短视频取流错误是否盖住画面", () => {
  test("当前条目已有存活媒体时不因查询错误黑屏", () => {
    expect(
      shortsPlaybackError({
        playerError: null,
        queryError: new Error("取流失败"),
        sourceLive: true,
      }),
    ).toBeNull();
  });

  test("没有存活媒体时展示查询错误", () => {
    expect(
      shortsPlaybackError({
        playerError: null,
        queryError: { message: "取流失败" },
        sourceLive: false,
      }),
    ).toBe("取流失败");
  });

  test("播放器致命错误优先于查询错误，且不受 sourceLive 影响", () => {
    expect(
      shortsPlaybackError({
        playerError: "视频播放失败",
        queryError: { message: "取流失败" },
        sourceLive: true,
      }),
    ).toBe("视频播放失败");
  });
});
