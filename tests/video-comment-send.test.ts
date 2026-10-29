import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  VIDEO_COMMENT_MAX_LENGTH,
  invalidateVideoComments,
  isVideoCommentLoginError,
  setCommentLikedInCache,
  videoCommentDraftError,
  videoCommentErrorMessage,
  videoCommentReplyTarget,
  withCommentLiked,
  withVideoCommentSubmitLock,
} from "../src/features/video/videoCommentSubmission";
import type { VideoComment } from "../src/shared/types/video";
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
describe("回复目标", () => {
  test("回复一级评论时 root 与 parent 都是该评论", () => {
    expect(videoCommentReplyTarget({ rpid: 42, uname: "楼主" })).toEqual({
      root: 42,
      parent: 42,
      uname: "楼主",
    });
  });
  test("回复楼中楼时 root 是楼层、parent 是被回复的那条", () => {
    expect(videoCommentReplyTarget({ rpid: 77, uname: "路人甲" }, { rpid: 42 })).toEqual({
      root: 42,
      parent: 77,
      uname: "路人甲",
    });
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
  test("成功使当前稿件的评论与楼中楼失效，但不伪造回显或污染其他视频", () => {
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
      ["video_comment_replies", "456", 10],
    ]) {
      client.setQueryData(key, page);
    }
    invalidateVideoComments(client, "123");
    expect(client.getQueryState(["video_comments", "123", 2])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["video_comments", "123", 3])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["video_comments", "456", 3])?.isInvalidated).toBe(false);
    expect(client.getQueryState(["video_comment_replies", "123", 10])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["video_comment_replies", "456", 10])?.isInvalidated).toBe(false);
    expect(client.getQueryState(["video_archive", "BVtest"])?.isInvalidated).toBe(true);
    expect(client.getQueryData(["video_comments", "123", 3])).toEqual(page);
    client.clear();
  });
});

function comment(rpid: number, like: number, replies: VideoComment[] = []): VideoComment {
  return {
    rpid,
    mid: "1",
    uname: `u${rpid}`,
    avatar: null,
    level: 1,
    message: "",
    emotes: [],
    pictures: [],
    like,
    ctime: 0,
    rcount: replies.length,
    replies,
    is_upper: false,
    liked: false,
  };
}
describe("评论点赞", () => {
  test("同一 rpid 在列表与回复预览里同步切换，状态未变时不重复计数", () => {
    const list = [comment(1, 3, [comment(2, 0)]), comment(3, 5)];
    const liked = withCommentLiked(list, 2, true);
    expect(liked[0]?.replies[0]).toMatchObject({ liked: true, like: 1 });
    expect(liked[1]).toBe(list[1]);
    expect(withCommentLiked(liked, 2, true)).toBe(liked);
    expect(withCommentLiked(liked, 2, false)[0]?.replies[0]).toMatchObject({
      liked: false,
      like: 0,
    });
    expect(withCommentLiked(list, 99, true)).toBe(list);
  });
  test("就地改写当前稿件的列表与楼中楼缓存，不碰其他稿件", () => {
    const client = new QueryClient();
    const page = (items: VideoComment[]) => ({
      all_count: items.length,
      next: 0,
      has_more: false,
      items,
    });
    client.setQueryData(["video_comments", "123", 3], {
      pages: [page([comment(1, 3)])],
      pageParams: [0],
    });
    client.setQueryData(["video_comment_replies", "123", 1, 1, 10], page([comment(1, 3)]));
    client.setQueryData(["video_comments", "456", 3], {
      pages: [page([comment(1, 3)])],
      pageParams: [0],
    });
    setCommentLikedInCache(client, "123", 1, true);
    const list = client.getQueryData<{ pages: { items: VideoComment[] }[] }>([
      "video_comments",
      "123",
      3,
    ]);
    expect(list?.pages[0]?.items[0]).toMatchObject({ liked: true, like: 4 });
    const replies = client.getQueryData<{ items: VideoComment[] }>([
      "video_comment_replies",
      "123",
      1,
      1,
      10,
    ]);
    expect(replies?.items[0]).toMatchObject({ liked: true, like: 4 });
    const other = client.getQueryData<{ pages: { items: VideoComment[] }[] }>([
      "video_comments",
      "456",
      3,
    ]);
    expect(other?.pages[0]?.items[0]).toMatchObject({ liked: false, like: 3 });
    expect(client.getQueryState(["video_comments", "123", 3])?.isInvalidated).toBe(false);
    client.clear();
  });
});
