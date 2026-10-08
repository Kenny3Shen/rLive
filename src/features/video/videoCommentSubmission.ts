import type { QueryClient } from "@tanstack/react-query";

/** Web 文本框按 UTF-16 码元计数；Rust 再做权威校验。 */
export const VIDEO_COMMENT_MAX_LENGTH = 1000;

export function videoCommentDraftError(message: string): string | null {
  const text = message.trim();
  if (!text) return "请输入评论内容";
  if (text.length > VIDEO_COMMENT_MAX_LENGTH) return "评论不能超过 1000 字符";
  return null;
}

export function isVideoCommentLoginError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return (
    error.code === "video_comment_login_required" || error.code === "video_comment_login_expired"
  );
}

export function videoCommentErrorMessage(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "评论发送失败，请稍后再试";
}

/** 不插入乐观评论；平台可能审核或限制可见性，列表仍以上游读取结果为准。 */
export function invalidateVideoComments(queryClient: QueryClient, aid: string): void {
  void queryClient.invalidateQueries({ queryKey: ["video_comments", aid] });
  // archive 同时包含评论数量；其 key 以 bvid 为维度，不在前端复制 aid/bvid 转换。
  void queryClient.invalidateQueries({ queryKey: ["video_archive"] });
}

/** 同一事件循环内的重复提交也要拦截，不能只等 React 重渲染禁用按钮。 */
export async function withVideoCommentSubmitLock(
  lock: { current: boolean },
  submit: () => Promise<void>,
): Promise<void> {
  if (lock.current) return;
  lock.current = true;
  try {
    await submit();
  } finally {
    lock.current = false;
  }
}
