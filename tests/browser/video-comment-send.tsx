import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { mockIPC } from "@tauri-apps/api/mocks";
import { Toaster } from "../../src/components/ui/toast";
import { CommentsPanel } from "../../src/features/video/CommentsPanel";
import { VideoCommentComposer } from "../../src/features/video/VideoCommentComposer";
import { DanmakuComposer } from "../../src/features/room/BilibiliDanmakuComposer";
import type { VideoComment, VideoCommentPage } from "../../src/shared/types/video";
import "../../src/styles.css";

/**
 * 独立普通浏览器夹具：真实发送组件、真实评论查询与通知，仅 IPC 是内存桩。
 * 不允许在原生窗口中覆盖桥；未识别命令直接失败，绝不回落真实 IPC 或站点请求。
 */
if (
  location.hostname !== "127.0.0.1" ||
  location.port !== "1421" ||
  "__TAURI_INTERNALS__" in window
) {
  throw new Error("评论发送夹具仅允许在 127.0.0.1:1421 的独立普通浏览器中运行");
}
Object.assign(window, { isTauri: true });

type Outcome = "success" | "rejected" | "expired" | "missing" | "pending";
type SettledOutcome = Exclude<Outcome, "pending">;
type SendCall = { aid: string; message: string };
const sendCalls: SendCall[] = [];
const readCalls: { aid: string; mode: number; next: number }[] = [];
const pending = new Map<number, (outcome: SettledOutcome) => void>();
const replies = new Map<string, VideoComment[]>();
let outcome: Outcome = "success";

function makeComment(aid: string, message: string): VideoComment {
  return {
    rpid: Number(aid) * 100 + (replies.get(aid)?.length ?? 0),
    mid: "1",
    uname: "夹具作者",
    avatar: null,
    level: 3,
    is_upper: false,
    ctime: 1_700_000_000,
    like: 0,
    rcount: 0,
    message,
    emotes: [],
    pictures: [],
    replies: [],
  };
}
for (const aid of ["123", "456"]) replies.set(aid, [makeComment(aid, `现有评论 ${aid}`)]);

mockIPC(async (command, payload) => {
  if (command === "bilibili_danmaku_send_status") {
    return { cookie_ready: true, available: true, message: "已登录" };
  }
  if (command === "video_get_comments") {
    const args = payload as { aid: string; mode: number; next: number };
    readCalls.push({ ...args });
    const items = [...(replies.get(args.aid) ?? [])];
    return { items, all_count: items.length, has_more: false, next: 0 } satisfies VideoCommentPage;
  }
  if (command === "video_comment_send") {
    const args = payload as SendCall;
    const index = sendCalls.push({ ...args }) - 1;
    const result =
      outcome === "pending"
        ? await new Promise<SettledOutcome>((resolve) => pending.set(index, resolve))
        : outcome;
    pending.delete(index);
    if (result !== "success") {
      const failure = {
        rejected: { code: "video_comment_send_rejected", message: "测试拒绝：评论区暂时限制发送" },
        expired: { code: "video_comment_login_expired", message: "测试登录已失效，请重新登录" },
        missing: {
          code: "video_comment_login_required",
          message: "测试未登录，请先登录 B站 Web 账号",
        },
      }[result];
      throw { ...failure, site: "bilibili", retryable: false };
    }
    const comment = makeComment(args.aid, args.message);
    replies.set(args.aid, [comment, ...(replies.get(args.aid) ?? [])]);
    return null;
  }
  throw new Error(`评论夹具拒绝未模拟的命令：${command}`);
});

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Infinity },
    // 故意让全局自动重试，验证组件 retry:false 能覆盖它。
    mutations: { retry: 3, retryDelay: 0 },
  },
});
// 非当前稿件缓存不应受成功写入影响。
client.setQueryData(["video_comments", "999", 3], { pages: [], pageParams: [] });

function Fixture() {
  const [aid, setAid] = useState("123");
  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col bg-card">
      <header className="flex shrink-0 items-center gap-3 p-3">
        <span data-testid="current-aid">稿件 {aid}</span>
        <button type="button" onClick={() => setAid(aid === "123" ? "456" : "123")}>
          切换稿件
        </button>
      </header>
      <section aria-label="弹幕输入对照">
        <DanmakuComposer video={{ cid: 1, aid, progressMs: 0 }} />
      </section>
      <div data-testid="comment-list" className="min-h-0 flex-1 overflow-y-auto">
        <CommentsPanel aid={aid} />
      </div>
      <VideoCommentComposer aid={aid} />
    </main>
  );
}

Object.assign(window, {
  videoCommentFixture: {
    mockOnly: true,
    client,
    sendCalls,
    readCalls,
    setOutcome(next: Outcome) {
      outcome = next;
    },
    settle(index: number, result: SettledOutcome = "success") {
      const resolve = pending.get(index);
      if (!resolve) throw new Error(`没有等待中的模拟发送 ${index}`);
      resolve(result);
    },
    pendingCount() {
      return pending.size;
    },
    cachedMessages(aid: string, mode = 3) {
      return (
        client
          .getQueryData<{ pages: VideoCommentPage[] }>(["video_comments", aid, mode])
          ?.pages.flatMap((page) => page.items.map((comment) => comment.message)) ?? []
      );
    },
  },
});
createRoot(document.getElementById("fixture")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Toaster>
          <Fixture />
        </Toaster>
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
