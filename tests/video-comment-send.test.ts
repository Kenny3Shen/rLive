import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VideoCommentComposer } from "../src/features/video/VideoCommentComposer";
import {
  COMMENT_COMPOSER_TONE_CLASS,
  DANMAKU_COMPOSER_TONE_CLASS,
  MESSAGE_COMPOSER_SURFACE_CLASS,
  commentComposerToneClass,
} from "../src/shared/components/messageComposerStyles";
import {
  VIDEO_COMMENT_MAX_LENGTH,
  invalidateVideoComments,
  isVideoCommentLoginError,
  videoCommentDraftError,
  videoCommentErrorMessage,
  withVideoCommentSubmitLock,
} from "../src/features/video/videoCommentSubmission";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const composerSource = read("../src/features/video/VideoCommentComposer.tsx");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderComposer(aid: string) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(MemoryRouter, null, createElement(VideoCommentComposer, { aid })),
    ),
  );
}

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

  test("初始空白不允许发送且输入框有可访问标签", () => {
    const html = renderComposer("123");
    expect(html).toContain("评论内容</label>");
    expect(html).toContain('name="comment"');
    expect(html).toContain('maxLength="1000"');
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain("发送评论");
    expect(html).not.toContain("root=");
  });

  test("使用同款紧凑输入组、内嵌发送图标，不再叠分隔线", () => {
    const html = renderComposer("123");
    expect(html).toContain('data-slot="input-group"');
    expect(html).toContain('rows="1"');
    expect(html).toContain('aria-label="发送评论"');
    expect(html).toContain('data-align="inline-end"');
    expect(html).not.toContain('role="separator"');
    expect(composerSource).toContain("MESSAGE_COMPOSER_SURFACE_CLASS");
    expect(composerSource).toContain("messageComposerSendButtonClass(canSubmit)");
    const danmaku = read("../src/features/room/BilibiliDanmakuComposer.tsx");
    expect(danmaku).toContain("MESSAGE_COMPOSER_SURFACE_CLASS");
    expect(danmaku).toContain("messageComposerSendButtonClass(canSubmit)");
    // 几何共用、底色分开：评论与弹幕页签相邻，同一底色下读不出当前发送的是哪种。
    // 移动端两个发送区都贴在播放器下方同一块侧栏底部，底色统一。
    expect(composerSource).toContain("commentComposerToneClass(isMobileClient())");
    expect(danmaku).toContain("DANMAKU_COMPOSER_TONE_CLASS");
    expect(COMMENT_COMPOSER_TONE_CLASS).not.toBe(DANMAKU_COMPOSER_TONE_CLASS);
    expect(commentComposerToneClass(false)).toBe(COMMENT_COMPOSER_TONE_CLASS);
    expect(commentComposerToneClass(true)).toBe(DANMAKU_COMPOSER_TONE_CLASS);
    expect(MESSAGE_COMPOSER_SURFACE_CLASS).not.toMatch(/\bbg-/);
    expect(composerSource).toContain("event.nativeEvent.isComposing");
    expect(composerSource).toContain("event.shiftKey");
  });

  test("未取得 aid 时禁用输入，不拿 cid 或 bvid 冒充评论区 id", () => {
    const html = renderComposer("");
    expect(html).toContain("正在获取视频信息");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });
});

describe("提交锁与结果反馈", () => {
  test("同一事件循环重入只调用一次，完成后才允许下一次显式提交", async () => {
    const lock = { current: false };
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
    const lock = { current: false };
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

  test("仅成功清空草稿；未知结果不启用 TanStack 自动重试", () => {
    expect(composerSource).toContain("retry: false");
    expect(composerSource).toContain("withVideoCommentSubmitLock(submitLock");
    const success = composerSource.slice(
      composerSource.indexOf("onSuccess:"),
      composerSource.indexOf("onError:"),
    );
    expect(success).toContain('setMessage("")');
    expect(success).toContain("invalidateVideoComments(queryClient, aid)");
    expect(success).toContain('notify.success("评论已提交"');
    const failure = composerSource.slice(
      composerSource.indexOf("onError:"),
      composerSource.indexOf("const draftError"),
    );
    expect(failure).not.toContain("setMessage");
    expect(failure).toContain("notify.error");
  });

  test("切换稿件隔离草稿与未完成请求，发送中禁用编辑", () => {
    expect(composerSource).toContain("key={aid}");
    expect(composerSource).toContain("disabled={mutation.isPending || !aid}");
  });
});

describe("登录失效和缓存", () => {
  test("只将明确缺失 Cookie 或失效错误判为需要登录", () => {
    expect(isVideoCommentLoginError({ code: "video_comment_login_required" })).toBe(true);
    expect(isVideoCommentLoginError({ code: "video_comment_login_expired" })).toBe(true);
    for (const error of [
      null,
      "过期",
      { code: "video_comment_send_unknown" },
      { code: "video_comment_send_limited" },
      new Error("网络失败"),
    ]) {
      expect(isVideoCommentLoginError(error)).toBe(false);
    }
    expect(composerSource).toContain('to="/settings?section=account"');
    expect(composerSource).not.toContain("account_clear_cookie");
  });

  test("错误采用后端安全文案并保留未知状态说明", () => {
    expect(videoCommentErrorMessage({ message: "状态未知，请先确认" })).toBe("状态未知，请先确认");
    expect(videoCommentErrorMessage(null)).toBe("评论发送失败，请稍后再试");
  });

  test("成功使当前稿件的最热、最新评论失效，但不伪造回显或污染其他视频", () => {
    const client = new QueryClient();
    const page = { pages: [{ items: [], all_count: 0 }], pageParams: [0] };
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

describe("发送边界", () => {
  test("IPC 只接收 aid 和文本，前端不读取 Cookie/CSRF", () => {
    const api = read("../src/features/video/videoApi.ts");
    expect(api).toContain('invokeCmd<void>("video_comment_send", { aid, message })');
    expect(composerSource).not.toContain("account_get_cookie");
    const commands = read("../src-tauri/src/commands/video.rs");
    const send = commands.slice(
      commands.indexOf("pub async fn video_comment_send"),
      commands.indexOf("pub async fn video_get_comment_replies"),
    );
    expect(send).toContain("account::get_cookie");
    expect(send).toContain("build_no_redirect_client(&route)");
    expect(send).not.toContain("ensure_bilibili_send_ready");
    expect(send).not.toContain("danmaku_send_enabled");
    expect(read("../src-tauri/src/lib.rs")).toContain("            video_comment_send,");
  });
});
