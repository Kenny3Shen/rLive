import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowUpDown, ChevronUp, ThumbsUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/shared/components/ErrorState";
import { ImageViewer } from "@/shared/components/ImageViewer";
import { LinkText } from "@/shared/components/LinkText";
import { LoadMoreRow } from "@/shared/components/LoadMoreRow";
import { videoCommentStyles } from "@/shared/components/videoCommentsStyle";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import {
  acfunArticleGetCommentReplies,
  acfunArticleGetComments,
  acfunCommentNextCursor,
  acfunCommentNextPage,
  acfunVideoGetCommentReplies,
  acfunVideoGetComments,
} from "./acfunApi";
import type { AcfunCommentSort, AcfunVideoComment } from "./acfunTypes";
import { formatRelativeTime } from "@/features/video/videoHistory";

function commentTime(timestamp: number): string {
  if (!timestamp) return "";
  const seconds = timestamp > 10_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
  return formatRelativeTime(seconds);
}

function dedupeComments(pages: readonly AcfunVideoComment[][]): AcfunVideoComment[] {
  return Array.from(new Map(pages.flat().map((comment) => [comment.id, comment])).values());
}

export type AcfunCommentResource = { kind: "video"; id: string } | { kind: "article"; id: string };

function getComments(resource: AcfunCommentResource, page: number, sort: AcfunCommentSort) {
  return resource.kind === "video"
    ? acfunVideoGetComments({ videoId: resource.id, page, sort })
    : acfunArticleGetComments({ articleId: resource.id, page, sort });
}

function getCommentReplies(
  resource: AcfunCommentResource,
  commentId: string,
  cursor: string | null,
) {
  return resource.kind === "video"
    ? acfunVideoGetCommentReplies({ videoId: resource.id, commentId, cursor })
    : acfunArticleGetCommentReplies({ articleId: resource.id, commentId, cursor });
}

function CommentPictures({ pictures }: { pictures: readonly string[] }) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  if (pictures.length === 0) return null;

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {pictures.map((picture, index) => (
          <button
            key={`${picture}:${index}`}
            type="button"
            className="group relative overflow-hidden rounded-md transition-opacity hover:opacity-90"
            aria-label={`查看评论图片 ${index + 1}`}
            onClick={() => setViewerIndex(index)}
          >
            <img
              src={normalizeImageUrl(picture)}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="h-20 w-28 object-cover"
            />
            <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
          </button>
        ))}
      </div>
      {viewerIndex !== null && (
        <ImageViewer
          images={[...pictures]}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </>
  );
}

function CommentAvatar({ comment }: { comment: AcfunVideoComment }) {
  if (comment.avatar) {
    return (
      <img
        src={normalizeImageUrl(comment.avatar)}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className={videoCommentStyles.avatar}
      />
    );
  }
  return <div className={videoCommentStyles.avatarPlaceholder} aria-hidden />;
}

function CommentUpBadge() {
  return (
    <Badge variant="secondary" className={videoCommentStyles.upBadge}>
      UP
    </Badge>
  );
}

function CommentRow({ comment }: { comment: AcfunVideoComment }) {
  const author = comment.author.trim() || "AcFun 用户";
  const time = commentTime(comment.created_at);

  return (
    <div className={videoCommentStyles.row}>
      <CommentAvatar comment={comment} />
      <div className="min-w-0 flex-1">
        <div className={videoCommentStyles.metaRow}>
          <span className={videoCommentStyles.mainAuthor}>{author}</span>
          {comment.is_uploader && <CommentUpBadge />}
          {comment.reply_to_name && (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              回复 {comment.reply_to_name}
            </span>
          )}
        </div>
        {time && <div className={videoCommentStyles.time}>{time}</div>}
        <div className={videoCommentStyles.bodyWrap}>
          <p className={videoCommentStyles.body}>
            <LinkText text={comment.content} />
          </p>
          <CommentPictures pictures={comment.pictures} />
        </div>
        <div className={videoCommentStyles.actionRow}>
          <div
            className={videoCommentStyles.actionStat}
            aria-label={`${formatOnline(comment.like_count)} 个赞`}
          >
            <ThumbsUp aria-hidden className="size-3" />
            <span className="tabular-nums">{formatOnline(comment.like_count)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReplyPreview({ comment, onOpen }: { comment: AcfunVideoComment; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={cn("block", videoCommentStyles.previewButton)}
      aria-label={`查看 ${comment.author || "用户"} 的回复详情`}
      onClick={onOpen}
    >
      <span className={videoCommentStyles.previewText}>
        <span className={videoCommentStyles.previewAuthor}>{comment.author || "AcFun 用户"}</span>
        {comment.is_uploader && <span className={videoCommentStyles.inlineUpBadge}>UP</span>}
        {comment.reply_to_name && (
          <span className="text-muted-foreground"> 回复 {comment.reply_to_name}</span>
        )}
        <span className="text-muted-foreground">： </span>
        <span className="text-foreground/80">{comment.content}</span>
        {comment.pictures.length > 0 && <span className="text-muted-foreground"> [图片]</span>}
      </span>
    </button>
  );
}

function CommentReplies({
  resource,
  comment,
  active,
  onCollapse,
}: {
  resource: AcfunCommentResource;
  comment: AcfunVideoComment;
  active: boolean;
  onCollapse: () => void;
}) {
  const repliesQuery = useInfiniteQuery({
    queryKey: ["acfun_comment_replies", resource.kind, resource.id, comment.id],
    enabled: active && resource.id !== "" && comment.reply_count > 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => getCommentReplies(resource, comment.id, pageParam),
    getNextPageParam: (lastPage) => acfunCommentNextCursor(lastPage),
  });
  const replies = dedupeComments(repliesQuery.data?.pages.map((page) => page.items) ?? []);
  const total = repliesQuery.data?.pages[0]?.total ?? comment.reply_count;
  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    enabled: active,
    hasNextPage: repliesQuery.hasNextPage,
    isFetchingNextPage: repliesQuery.isFetchingNextPage,
    isFetchNextPageError: repliesQuery.isFetchNextPageError,
    fetchNextPage: () => repliesQuery.fetchNextPage(),
  });

  return (
    <div role="group" aria-label={`${comment.author || "用户"} 的评论回复`}>
      <div className={videoCommentStyles.replyHeader}>
        <span className={videoCommentStyles.replyCount}>全部回复 {formatOnline(total)}</span>
        <Button
          variant="ghost"
          size="sm"
          className={videoCommentStyles.replyActionButton}
          aria-label={`收起 ${comment.author || "用户"} 的评论回复`}
          onClick={onCollapse}
        >
          收起
          <ChevronUp data-icon="inline-end" aria-hidden />
        </Button>
      </div>
      {repliesQuery.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner aria-label="正在加载回复" />
        </div>
      ) : repliesQuery.isError && !repliesQuery.data ? (
        <div className="py-2">
          <ErrorState
            error={repliesQuery.error}
            title="回复加载失败"
            onRetry={() => void repliesQuery.refetch()}
          />
        </div>
      ) : replies.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂无回复</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className={cn(repliesQuery.isFetching && "opacity-60")}>
          {replies.map((reply) => (
            <div key={reply.id} className={videoCommentStyles.replyRow}>
              <CommentRow comment={reply} />
            </div>
          ))}
          <LoadMoreRow
            scroll={{ loadMore, loadMoreRef, supportsIntersectionObserver }}
            query={repliesQuery}
            loadingLabel="正在加载更多回复"
            retryLabel="重试加载更多回复"
            loadMoreLabel="加载更多回复"
            endLabel="没有更多回复了"
            className="min-h-14"
          />
        </div>
      )}
    </div>
  );
}

function CommentThread({
  resource,
  comment,
  active,
  expanded,
  onToggle,
}: {
  resource: AcfunCommentResource;
  comment: AcfunVideoComment;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const previews = comment.replies.slice(0, 3);
  const showPreview = !expanded && (comment.reply_count > 0 || previews.length > 0);

  return (
    <div className={videoCommentStyles.thread}>
      <CommentRow comment={comment} />
      {showPreview && (
        <div className={videoCommentStyles.previewIndent}>
          <div className={videoCommentStyles.previewSurface}>
            {previews.map((reply) => (
              <ReplyPreview key={reply.id} comment={reply} onOpen={onToggle} />
            ))}
            {previews.length < comment.reply_count && (
              <button
                type="button"
                className="w-full px-2 py-1.5 text-left text-xs text-primary/90 hover:bg-muted/70"
                onClick={onToggle}
              >
                共 {formatOnline(comment.reply_count)} 条回复
              </button>
            )}
          </div>
        </div>
      )}
      {expanded && (
        <div className={videoCommentStyles.previewIndent}>
          <CommentReplies
            key={comment.id}
            resource={resource}
            comment={comment}
            active={active}
            onCollapse={onToggle}
          />
        </div>
      )}
    </div>
  );
}

function CommentsSkeleton() {
  return (
    <div className={videoCommentStyles.skeletonList} aria-hidden>
      {[0, 1, 2].map((index) => (
        <div key={index} className={videoCommentStyles.skeletonRow}>
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex w-full flex-col gap-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AcfunComments({
  resource,
  active,
}: {
  resource: AcfunCommentResource;
  active: boolean;
}) {
  const [sort, setSort] = useState<AcfunCommentSort>("hot");
  const [expandedComment, setExpandedComment] = useState<{
    resourceKind: AcfunCommentResource["kind"];
    resourceId: string;
    commentId: string | null;
  }>({ resourceKind: resource.kind, resourceId: resource.id, commentId: null });
  const expandedCommentId =
    expandedComment.resourceKind === resource.kind && expandedComment.resourceId === resource.id
      ? expandedComment.commentId
      : null;
  const commentsQuery = useInfiniteQuery({
    queryKey: ["acfun_comments", resource.kind, resource.id, sort],
    enabled: active && resource.id !== "",
    initialPageParam: 1,
    queryFn: ({ pageParam }) => getComments(resource, pageParam, sort),
    getNextPageParam: (lastPage, _, lastPageParam) => acfunCommentNextPage(lastPage, lastPageParam),
  });
  const pages = commentsQuery.data?.pages ?? [];
  const comments = dedupeComments(pages.map((page) => page.items));
  const total = pages[0]?.total ?? 0;
  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    enabled: active,
    hasNextPage: commentsQuery.hasNextPage,
    isFetchingNextPage: commentsQuery.isFetchingNextPage,
    isFetchNextPageError: commentsQuery.isFetchNextPageError,
    fetchNextPage: () => commentsQuery.fetchNextPage(),
  });

  return (
    <div
      className="flex min-h-full flex-col"
      aria-label={resource.kind === "video" ? "AcFun 视频评论" : "AcFun 文章评论"}
    >
      <div className={videoCommentStyles.panelHeader}>
        <span className={videoCommentStyles.panelCount} title="评论与回复的聚合总数">
          {total > 0 ? `共 ${formatOnline(total)} 条` : "评论"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={videoCommentStyles.sortButton}
          aria-label={`评论排序：${sort === "hot" ? "最热" : "最新"}，点击切换`}
          title="点击切换评论排序"
          onClick={() => {
            setSort((current) => (current === "hot" ? "time" : "hot"));
            setExpandedComment({
              resourceKind: resource.kind,
              resourceId: resource.id,
              commentId: null,
            });
          }}
        >
          {sort === "hot" ? "最热" : "最新"}
          <ArrowUpDown data-icon="inline-end" />
        </Button>
      </div>
      {commentsQuery.isPending ? (
        <CommentsSkeleton />
      ) : commentsQuery.isError && !commentsQuery.data ? (
        <div className="px-3 pb-4">
          <ErrorState
            error={commentsQuery.error}
            title="评论加载失败"
            onRetry={() => void commentsQuery.refetch()}
          />
        </div>
      ) : comments.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂无评论</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="px-3 pb-4">
          {comments.map((comment) => (
            <CommentThread
              key={comment.id}
              resource={resource}
              comment={comment}
              active={active}
              expanded={expandedCommentId === comment.id}
              onToggle={() => {
                setExpandedComment((current) => {
                  const sameResource =
                    current.resourceKind === resource.kind && current.resourceId === resource.id;
                  return {
                    resourceKind: resource.kind,
                    resourceId: resource.id,
                    commentId: sameResource && current.commentId === comment.id ? null : comment.id,
                  };
                });
              }}
            />
          ))}
          <LoadMoreRow
            scroll={{ loadMore, loadMoreRef, supportsIntersectionObserver }}
            query={commentsQuery}
            loadingLabel="正在加载更多评论"
            retryLabel="重试加载更多评论"
            loadMoreLabel="加载更多"
            className="min-h-10"
          />
        </div>
      )}
    </div>
  );
}

export function AcfunVideoComments({ videoId, active }: { videoId: string; active: boolean }) {
  return <AcfunComments resource={{ kind: "video", id: videoId }} active={active} />;
}
