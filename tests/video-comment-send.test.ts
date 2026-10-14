import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  VIDEO_COMMENT_MAX_LENGTH,
  invalidateVideoComments,
  isVideoCommentLoginError,
  videoCommentDraftError,
  videoCommentErrorMessage,
  withVideoCommentSubmitLock,
} from "../src/features/video/videoCommentSubmission";
import { deferred } from "./helpers/async";
describe("一级文本评论的输入边界", () => {
  test("空白不可提交，正文允许中文、换行和表情", () => {
    for (const message of ["", " ", "\n\t　"]) {
      expect(videoCommentDraftError(message)).toBe("请输入评论内容");
    }
    expect(videoCommentDraftError("  很棒\n第二行 😀  ")).toBeNull();
  });
  test("与 Web textarea 和 Rust 一致，限制 1000 UTF-16 码元", () => {
    expect(VIDEO_COMMENT_MAX_LENGTH).toBe(1000);
    expect(videoCommentDraftError("中".repeat(1000))).toBeNull();
    expect(videoCommentDraftError("中".repeat(1001))).not.toBeNull();
    expect(videoCommentDraftError("😀".repeat(500))).toBeNull();
    expect(videoCommentDraftError("😀".repeat(501))).not.toBeNull();
  });
});
describe("提交锁与结果反馈", () => {
  test("同一事件循环重入只调用一次，完成后才允许下一次显式提交", async () => {
    const lock = {
      current: false,
    };
    const wait = deferred();
    let calls = 0;
    const first = withVideoCommentSubmitLock(lock, async () => {
      calls += 1;
      await wait.promise;
    });
    expect(lock.current).toBe(true);
    await withVideoCommentSubmitLock(lock, async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
    wait.resolve();
    await first;
    expect(lock.current).toBe(false);
    await withVideoCommentSubmitLock(lock, async () => {
      calls += 1;
    });
    expect(calls).toBe(2);
  });
  test("失败释放锁但不自动重复调用", async () => {
    const lock = {
      current: false,
    };
    let calls = 0;
    await expect(
      withVideoCommentSubmitLock(lock, async () => {
        calls += 1;
        throw new Error("结果未知");
      }),
    ).rejects.toThrow("结果未知");
    expect(calls).toBe(1);
    expect(lock.current).toBe(false);
  });
});
describe("登录失效和缓存", () => {
  test("只将明确缺失 Cookie 或失效错误判为需要登录", () => {
    expect(
      isVideoCommentLoginError({
        code: "video_comment_login_required",
      }),
    ).toBe(true);
    expect(
      isVideoCommentLoginError({
        code: "video_comment_login_expired",
      }),
    ).toBe(true);
    for (const error of [
      null,
      "过期",
      {
        code: "video_comment_send_unknown",
      },
      {
        code: "video_comment_send_limited",
      },
      new Error("网络失败"),
    ]) {
      expect(isVideoCommentLoginError(error)).toBe(false);
    }
  });
  test("错误采用后端安全文案并保留未知状态说明", () => {
    expect(
      videoCommentErrorMessage({
        message: "状态未知，请先确认",
      }),
    ).toBe("状态未知，请先确认");
    expect(videoCommentErrorMessage(null)).toBe("评论发送失败，请稍后再试");
  });
  test("成功使当前稿件的最热、最新评论失效，但不伪造回显或污染其他视频", () => {
    const client = new QueryClient();
    const page = {
      pages: [
        {
          items: [],
          all_count: 0,
        },
      ],
      pageParams: [0],
    };
    for (const key of [
      ["video_comments", "123", 2],
      ["video_comments", "123", 3],
      ["video_comments", "456", 3],
      ["video_archive", "BVtest"],
      ["video_comment_replies", "123", 10],
    ]) {
      client.setQueryData(key, page);
    }
    invalidateVideoComments(client, "123");
    expect(client.getQueryState(["video_comments", "123", 2])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["video_comments", "123", 3])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["video_comments", "456", 3])?.isInvalidated).toBe(false);
    expect(client.getQueryState(["video_comment_replies", "123", 10])?.isInvalidated).toBe(false);
    expect(client.getQueryState(["video_archive", "BVtest"])?.isInvalidated).toBe(true);
    expect(client.getQueryData(["video_comments", "123", 3])).toEqual(page);
    client.clear();
  });
});
