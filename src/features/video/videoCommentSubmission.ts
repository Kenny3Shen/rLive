import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { VideoComment, VideoCommentPage } from "@/shared/types/video";

/** Web 文本框按 UTF-16 码元计数；Rust 再做权威校验。 */
export const VIDEO_COMMENT_MAX_LENGTH = 1000;

/**
 * 回复目标：`root` 是楼层的一级评论，`parent` 是被回复的那条。
 * 回复一级评论时两者相等；「回复 @昵称 :」前缀由 Rust 按 `parent !== root` 拼接。
 */
export type VideoCommentReplyTarget = {
  root: number;
  parent: number;
  uname: string;
};

/** `thread` 缺省表示回复一级评论本身。 */
export function videoCommentReplyTarget(
  comment: Pick<VideoComment, "rpid" | "uname">,
  thread: Pick<VideoComment, "rpid"> = comment,
): VideoCommentReplyTarget {
  return { root: thread.rpid, parent: comment.rpid, uname: comment.uname };
}

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
  // 桌面分页与移动端无限滚动的楼中楼 key 都以此为前缀，回复后楼层重新读取。
  void queryClient.invalidateQueries({ queryKey: ["video_comment_replies", aid] });
  // archive 同时包含评论数量；其 key 以 bvid 为维度，不在前端复制 aid/bvid 转换。
  void queryClient.invalidateQueries({ queryKey: ["video_archive"] });
}

/** 把某条评论（含嵌在回复预览里的）改成指定点赞状态；状态未变时原样返回，计数不重复加减。 */
export function withCommentLiked(
  comments: VideoComment[],
  rpid: number,
  liked: boolean,
): VideoComment[] {
  let changed = false;
  const next = comments.map((comment) => {
    const replies = withCommentLiked(comment.replies, rpid, liked);
    const self = comment.rpid === rpid && comment.liked !== liked;
    if (!self && replies === comment.replies) return comment;
    changed = true;
    return self
      ? { ...comment, replies, liked, like: Math.max(0, comment.like + (liked ? 1 : -1)) }
      : { ...comment, replies };
  });
  return changed ? next : comments;
}

type CommentCache = VideoCommentPage | InfiniteData<VideoCommentPage> | undefined;

function withPageLiked(page: VideoCommentPage, rpid: number, liked: boolean): VideoCommentPage {
  const items = withCommentLiked(page.items, rpid, liked);
  return items === page.items ? page : { ...page, items };
}

/**
 * 点赞是原地切换，不重新拉取：评论游标翻页重取会打乱已读位置。一级列表
 * （无限查询）与楼中楼（桌面分页 / 移动端无限滚动）三种缓存形状都就地改写。
 */
export function setCommentLikedInCache(
  queryClient: QueryClient,
  aid: string,
  rpid: number,
  liked: boolean,
): void {
  const update = (data: CommentCache): CommentCache => {
    if (!data) return data;
    if ("pages" in data) {
      const pages = data.pages.map((page) => withPageLiked(page, rpid, liked));
      return pages.every((page, index) => page === data.pages[index]) ? data : { ...data, pages };
    }
    return withPageLiked(data, rpid, liked);
  };
  queryClient.setQueriesData<CommentCache>({ queryKey: ["video_comments", aid] }, update);
  queryClient.setQueriesData<CommentCache>({ queryKey: ["video_comment_replies", aid] }, update);
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
