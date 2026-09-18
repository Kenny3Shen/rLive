import { useState, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, ThumbsUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  useDrawerScoped,
} from "@/components/ui/drawer";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/shared/components/ErrorState";
import { ImageViewer } from "@/shared/components/ImageViewer";
import { LinkText } from "@/shared/components/LinkText";
import { LoadMoreRow } from "@/shared/components/LoadMoreRow";
import { panelDrawerSide, panelDrawerSizeClass } from "@/shared/components/player/panelDrawer";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { isMobileClient } from "@/shared/clientPlatform";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import type { VideoComment } from "@/shared/types/video";
import { videoGetCommentReplies, videoGetComments } from "./videoApi";
import { formatRelativeTime } from "./videoHistory";

/**
 * B 站评论区：一级评论列表（游标翻页）+ 二级回复（pn 翻页）。
 *
 * 二级回复的形状**按客户端分端**，判据是 `isMobileClient()`（与侧栏横滑手势、
 * 弹幕设置面板同一判据：按输入模态分野，不按视口宽度）：
 * - 移动端（触摸）：抽屉二级页 + 无限滚动，页大小用后端默认（20）。
 * - 桌面端（指针）：**就地展开**在该条评论下方，上一页 / 下一页分页，每页 10 条。
 *   侧栏只有 320/340px，再叠一层抽屉会把一级列表整个盖住；展开 + 翻页让一级
 *   评论始终留在视野里，也不需要第二层浮层的几何对齐。
 *
 * 从 `VideoSidebar` 拆出来的原因是复用面：播放页右侧栏与短视频竖屏舞台都要它，
 * 而侧栏那个文件还装着相关视频、分集、选集、合集与弹幕设置 —— 短视频只为评论
 * 就把那一整串依赖拖进自己的 chunk 不合适。
 *
 * 评论接口的三个坑（游标语义、回复预览、pn 翻页）见 `docs/zh/B站视频功能-设计.md`
 * 第六节，实现在这里，不要在别处再写一份。
 */

/** 桌面端回复分页的页大小：请求与「共几页」的推导共用它。 */
const DESKTOP_REPLIES_PAGE_SIZE = 10;

/** 把 `[大哭]` 这类占位符换成内联表情图，正文里的 URL 渲染成可点链接。 */
function renderCommentMessage(message: string, emotes: VideoComment["emotes"]): ReactNode {
  if (!message) return message;
  if (emotes.length === 0) return <LinkText text={message} />;
  const parts: ReactNode[] = [];
  let rest = message;
  let key = 0;
  while (rest) {
    let hit: { index: number; text: string; url: string } | null = null;
    for (const emote of emotes) {
      if (!emote.text) continue;
      const index = rest.indexOf(emote.text);
      if (index !== -1 && (!hit || index < hit.index)) {
        hit = { index, text: emote.text, url: emote.url };
      }
    }
    if (!hit) {
      parts.push(<LinkText key={key} text={rest} />);
      key += 1;
      break;
    }
    if (hit.index > 0) {
      parts.push(<LinkText key={key} text={rest.slice(0, hit.index)} />);
      key += 1;
    }
    parts.push(
      <img
        key={key}
        src={normalizeImageUrl(hit.url)}
        alt=""
        aria-hidden
        className="inline-block h-5 w-5 translate-y-[-2px] object-contain"
      />,
    );
    key += 1;
    rest = rest.slice(hit.index + hit.text.length);
  }
  return parts;
}

function CommentBody({
  comment,
  onOpenDetail,
}: {
  comment: VideoComment;
  onOpenDetail?: () => void;
}) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  const handleImageClick = (index: number) => {
    setViewerIndex(index);
    setViewerOpen(true);
  };

  return (
    <>
      {onOpenDetail ? (
        <button
          type="button"
          onClick={onOpenDetail}
          aria-label={`查看 ${comment.uname} 的评论详情`}
          className="block w-full rounded-sm text-left text-[13px] leading-relaxed whitespace-pre-line break-words [overflow-wrap:anywhere]"
        >
          {renderCommentMessage(comment.message, comment.emotes) || "图片评论"}
        </button>
      ) : (
        <p className="whitespace-pre-line break-words text-[13px] leading-relaxed [overflow-wrap:anywhere]">
          {renderCommentMessage(comment.message, comment.emotes)}
        </p>
      )}
      {comment.pictures.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {comment.pictures.map((src, index) => (
            <button
              key={src}
              type="button"
              aria-label={`查看评论图片 ${index + 1}`}
              onClick={() => handleImageClick(index)}
              className="group relative overflow-hidden rounded-md transition-opacity hover:opacity-90"
            >
              <img
                src={normalizeImageUrl(src)}
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
      )}
      {viewerOpen && (
        <ImageViewer
          images={comment.pictures}
          initialIndex={viewerIndex}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

/**
 * 评论发布者标识：`楼主`（当前楼层主，仅在评论详情里成立）与 `UP`（稿件作者）。
 *
 * 两者互不排斥：UP 在自己评论区里发的一级评论会同时是楼主。UP 用平台粉强调色，
 * 与 Lv 药丸、楼主药丸同属「弱于昵称」的一档，不抢注意力。
 */
function CommentAuthorBadges({
  isThreadAuthor = false,
  isUpper,
}: {
  isThreadAuthor?: boolean;
  isUpper: boolean;
}) {
  return (
    <>
      {isThreadAuthor && <Badge variant="secondary">楼主</Badge>}
      {isUpper && (
        // 覆盖 Badge 默认的 h-5/py-0.5：UP 标识要与 13px 昵称行等高，不把行撑高。
        <Badge
          variant="secondary"
          className="h-auto shrink-0 rounded-sm border-0 bg-accent/18 px-1 py-0 text-[10px] leading-4 font-semibold text-accent"
        >
          UP
        </Badge>
      )}
    </>
  );
}

function CommentRow({
  comment,
  onOpenDetail,
  isThreadAuthor = false,
}: {
  comment: VideoComment;
  onOpenDetail?: () => void;
  isThreadAuthor?: boolean;
}) {
  return (
    <div className="flex gap-2.5">
      {comment.avatar ? (
        <img
          src={normalizeImageUrl(comment.avatar)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="mt-0.5 size-8 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div className="mt-0.5 size-8 shrink-0 rounded-full bg-muted" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground/90">
            {comment.uname}
          </span>
          <CommentAuthorBadges isThreadAuthor={isThreadAuthor} isUpper={comment.is_upper} />
          {comment.level > 0 && (
            // 覆盖 Badge 默认的 h-5/py-0.5/font-medium：等级药丸要贴合 13px 昵称行。
            // 前景保持 muted：它比同排的「楼主」更弱，不能与昵称抢注意力。
            <Badge
              variant="secondary"
              className="h-auto shrink-0 rounded-sm border-0 px-1 py-0 text-[10px] leading-4 font-normal text-muted-foreground"
            >
              Lv{comment.level}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatRelativeTime(comment.ctime)}
        </div>
        <div className="mt-1">
          <CommentBody comment={comment} onOpenDetail={onOpenDetail} />
        </div>
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <ThumbsUp className="size-3" aria-hidden />
          <span>{formatOnline(comment.like)}</span>
        </div>
      </div>
    </div>
  );
}

function ReplyPreview({ reply, onOpenDetail }: { reply: VideoComment; onOpenDetail: () => void }) {
  return (
    <button
      type="button"
      className="block w-full px-2 py-1.5 text-left text-xs leading-relaxed transition-colors hover:bg-muted/70"
      onClick={onOpenDetail}
    >
      <span className="line-clamp-2 break-words [overflow-wrap:anywhere]">
        <span className="font-medium text-primary/90">{reply.uname}</span>
        {/* 预览是一行被裁剪的富文本，塞不进 Badge 的 20px 药丸；
            用等高（h-4 = leading-4）的 inline-flex 小标，行高不受影响。 */}
        {reply.is_upper && (
          <span className="mx-0.5 inline-flex h-4 items-center rounded-sm bg-accent/18 px-1 align-middle text-[10px] leading-4 font-semibold whitespace-nowrap text-accent">
            UP
          </span>
        )}
        <span className="text-muted-foreground">： </span>
        <span className="text-foreground/80">
          {renderCommentMessage(reply.message, reply.emotes)}
        </span>
        {reply.pictures.length > 0 && <span className="text-muted-foreground"> [图片]</span>}
      </span>
    </button>
  );
}

/** 一条一级评论与 PiliPlus 风格的二级回复预览（收起态）。 */
function CommentThread({
  aid,
  comment,
  expanded,
  onToggleDetail,
}: {
  aid: string;
  comment: VideoComment;
  /** 桌面端：本条是否就地展开了完整回复；移动端恒为 false。 */
  expanded: boolean;
  onToggleDetail: () => void;
}) {
  const previewReplies = comment.replies.slice(0, 3);
  // 展开态不再画预览与入口：完整列表就在下面，重复一份只会把楼层拉长。
  const showPreview = !expanded && (comment.rcount > 0 || previewReplies.length > 0);

  return (
    <div className="border-b border-border/60 py-3 last:border-b-0">
      <CommentRow comment={comment} onOpenDetail={onToggleDetail} />
      {showPreview && (
        <div className="mt-2 pl-10.5">
          <div className="overflow-hidden rounded-md bg-muted/40 py-1">
            {previewReplies.map((reply) => (
              <ReplyPreview key={reply.rpid} reply={reply} onOpenDetail={onToggleDetail} />
            ))}
            {previewReplies.length < comment.rcount && (
              <button
                type="button"
                className="w-full px-2 py-1.5 text-left text-xs text-primary/90 hover:bg-muted/70"
                onClick={onToggleDetail}
              >
                共 {formatOnline(comment.rcount)} 条回复
              </button>
            )}
          </div>
        </div>
      )}
      {expanded && (
        <div className="mt-2 pl-10.5">
          {/* key 换楼层即重挂：翻到第 3 页再展开另一条，不该停在那一页。 */}
          <InlineCommentReplies key={comment.rpid} aid={aid} comment={comment} />
        </div>
      )}
    </div>
  );
}

/**
 * 桌面端的就地回复列表：展开在一级评论下方，按页切换，每页 10 条。
 *
 * 用 `useQuery` 而不是 `useInfiniteQuery`：这里是**翻页**（换页即换内容）而不是
 * 无限累积，累积式会把「回到第 1 页」变成一次全量重取。`keepPreviousData` 让
 * 翻页期间旧页留在原地，列表不闪空也不跳高。
 *
 * 不自带滚动容器 —— 与 `CommentsPanel` 整体的约定一致（滚动由调用方提供）；
 * 也不需要安全区让位：它不是浮层，不存在压住系统手势条的问题。
 */
function InlineCommentReplies({ aid, comment }: { aid: string; comment: VideoComment }) {
  const [page, setPage] = useState(1);
  const repliesQuery = useQuery({
    queryKey: ["video_comment_replies", aid, comment.rpid, page, DESKTOP_REPLIES_PAGE_SIZE],
    queryFn: () => videoGetCommentReplies(aid, comment.rpid, page, DESKTOP_REPLIES_PAGE_SIZE),
    placeholderData: keepPreviousData,
  });
  const data = repliesQuery.data;
  const replies = data?.items ?? [];
  const allCount = data?.all_count ?? comment.rcount;
  const pageCount = Math.max(1, Math.ceil(allCount / DESKTOP_REPLIES_PAGE_SIZE));
  // 末页以「本页之后的剩余」为准，同时不越过按总数推出的页数：
  // 上游总数与条目数不一致时（删除、风控）少走一次空页。
  const hasPrev = page > 1;
  const hasNext = page < pageCount && (data?.has_more ?? false);
  const pending = repliesQuery.isPending;

  return (
    <div role="group" aria-label={`${comment.uname} 的评论的回复`}>
      <div className="text-xs text-muted-foreground">全部回复 {formatOnline(allCount)}</div>
      {pending ? (
        <div className="flex justify-center py-6">
          <Spinner aria-label="正在加载回复" />
        </div>
      ) : repliesQuery.isError && !data ? (
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
            <div key={reply.rpid} className="border-b border-border/60 py-3 last:border-b-0">
              <CommentRow
                comment={reply}
                isThreadAuthor={Boolean(
                  comment.mid && comment.mid !== "0" && reply.mid === comment.mid,
                )}
              />
            </div>
          ))}
        </div>
      )}
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            aria-label={hasPrev ? `上一页回复，第 ${page - 1} 页` : "上一页回复"}
            disabled={!hasPrev || repliesQuery.isFetching}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <ChevronLeft data-icon="inline-start" aria-hidden />
            上一页
          </Button>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            第 {page} / {pageCount} 页
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            aria-label={hasNext ? `下一页回复，第 ${page + 1} 页` : "下一页回复"}
            disabled={!hasNext || repliesQuery.isFetching}
            onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
          >
            下一页
            <ChevronRight data-icon="inline-end" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * 移动端抽屉里的完整回复列表（pn 无限滚动）。
 *
 * 页大小走后端默认（20）：这一层是浮层里的长列表，滑动到底自动续，
 * 桌面端那个 10 条一翻的节奏在这里没有意义。
 */
function CommentReplies({
  aid,
  comment,
  bottomInset,
}: {
  aid: string;
  comment: VideoComment;
  /** 滚动容器内侧的底部安全区，见 `CommentsPanel` 的同名参数。 */
  bottomInset?: string;
}) {
  const repliesQuery = useInfiniteQuery({
    queryKey: ["video_comment_replies", aid, comment.rpid],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => videoGetCommentReplies(aid, comment.rpid, pageParam),
    getNextPageParam: (lastPage, _, lastPageParam) =>
      lastPage.has_more ? lastPageParam + 1 : undefined,
  });
  // 完整列表沿接口顺序展示，预览不插入分页数据，避免重复或打乱楼层顺序。
  const replies = Array.from(
    new Map(
      repliesQuery.data?.pages.flatMap((page) =>
        page.items.map((reply) => [reply.rpid, reply] as const),
      ),
    ).values(),
  );
  const allCount = repliesQuery.data?.pages[0]?.all_count ?? comment.rcount;
  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    hasNextPage: repliesQuery.hasNextPage,
    isFetchingNextPage: repliesQuery.isFetchingNextPage,
    isFetchNextPageError: repliesQuery.isFetchNextPageError,
    fetchNextPage: () => repliesQuery.fetchNextPage(),
  });

  return (
    // touch-pan-y：与页签面板同理，滚动容器自身必须让出横向，否则侧栏横滑切页签
    // 在这一层上会被合成器当作滚动接走（见页签面板处的说明）。
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y"
      // 底部安全区加在滚动容器**内侧**：底部抽屉形态下外壳用 `p-0`（表头要贴边），
      // 不补回来的话手机上最后一条回复会压在系统手势条下面。
      style={{ paddingBottom: bottomInset }}
    >
      <div className="border-b border-border px-4 py-4">
        <CommentRow comment={comment} isThreadAuthor />
      </div>
      <div className="border-b border-border/60 px-4 py-3 text-xs text-muted-foreground">
        全部回复 {formatOnline(allCount)}
      </div>
      {repliesQuery.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner aria-label="正在加载回复" />
        </div>
      ) : repliesQuery.isError && !repliesQuery.data ? (
        <div className="p-4">
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
        <div className="px-4">
          {replies.map((reply) => (
            <div key={reply.rpid} className="border-b border-border/60 py-4 last:border-b-0">
              <CommentRow
                comment={reply}
                isThreadAuthor={Boolean(
                  comment.mid && comment.mid !== "0" && reply.mid === comment.mid,
                )}
              />
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

/** 评论列表：排序切换 + 游标翻页。 */
/**
 * 评论区。自带二级回复（形状按客户端分端，见文件头），只需一个 `aid`，因此
 * 短视频的评论抽屉直接复用它（导出而不是另写一份：评论的三个坑 —— 游标语义、
 * 回复预览、pn 翻页 —— 已经在这里跑通）。它不自带滚动容器，由调用方提供。
 */
export function CommentsPanel({ aid, bottomInset }: { aid: string; bottomInset?: string }) {
  const [mode, setMode] = useState(3);
  const [selectedComment, setSelectedComment] = useState<VideoComment | null>(null);
  const mobile = isMobileClient();
  // 抽屉只在移动端成立；桌面端同一份状态驱动「就地展开」。
  const repliesDrawerOpen = mobile && selectedComment !== null;
  // 二级回复抽屉的几何跟着托管它的那一层走：播放页把抽屉挂在侧栏的
  // `DrawerViewport` 里（scoped，基础组件自己改成 `absolute w-full`，此时不该再给尺寸），
  // 而短视频的评论抽屉是全窗口浮层 —— 二级必须自己拿到与一级相同的宽度与侧别，
  // 否则手机上一级是底部抽屉而二级从右侧滑入一条窄条（看上去不像同一套面板）。
  const scoped = useDrawerScoped();
  const compact = useCompactPlayerViewport();
  const repliesSide = panelDrawerSide(compact, scoped);
  const commentsQuery = useInfiniteQuery({
    queryKey: ["video_comments", aid, mode],
    enabled: aid !== "",
    initialPageParam: 0,
    queryFn: ({ pageParam }) => videoGetComments(aid, mode, pageParam),
    getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next : undefined),
  });
  const pages = commentsQuery.data?.pages ?? [];
  const comments = pages.flatMap((page) => page.items);
  const allCount = pages[0]?.all_count ?? 0;
  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    hasNextPage: commentsQuery.hasNextPage && selectedComment === null,
    isFetchingNextPage: commentsQuery.isFetchingNextPage,
    isFetchNextPageError: commentsQuery.isFetchNextPageError,
    fetchNextPage: () => commentsQuery.fetchNextPage(),
  });
  /**
   * 一次只展开一条：点同一条即收起（桌面端就地展开 / 移动端抽屉共用这个语义）。
   *
   * 三个入口（正文、回复预览、「共 N 条回复」）都走它 —— 它们是同一件事的
   * 三个落点，分开各写一遍会各自演化出不同的开关规则。
   */
  const toggleDetail = (comment: VideoComment) => {
    setSelectedComment((current) => (current?.rpid === comment.rpid ? null : comment));
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="text-xs text-muted-foreground">
          {allCount > 0 ? `共 ${formatOnline(allCount)} 条` : "评论"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground"
          aria-label={`评论排序：${mode === 3 ? "最热" : "最新"}，点击切换`}
          title="点击切换评论排序"
          onClick={() => setMode(mode === 3 ? 2 : 3)}
        >
          {mode === 3 ? "最热" : "最新"}
          <ArrowUpDown data-icon="inline-end" />
        </Button>
      </div>
      {commentsQuery.isPending ? (
        <div className="flex flex-col gap-4 px-3 pb-4">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex gap-2.5">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex w-full flex-col gap-1.5">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : commentsQuery.isError && !commentsQuery.data ? (
        <div className="px-3 pb-4">
          <ErrorState
            error={commentsQuery.error}
            title="评论加载失败"
            onRetry={() => void commentsQuery.refetch()}
          />
        </div>
      ) : comments.length === 0 ? (
        <p className="px-3 pb-6 pt-4 text-center text-xs text-muted-foreground">暂无评论</p>
      ) : (
        <div className="px-3 pb-4">
          {comments.map((comment) => (
            <CommentThread
              key={comment.rpid}
              aid={aid}
              comment={comment}
              expanded={!mobile && selectedComment?.rpid === comment.rpid}
              onToggleDetail={() => toggleDetail(comment)}
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
      <Drawer
        open={repliesDrawerOpen}
        // 移动端：二级回复开着时点播放器只做播放器自己的事（切 HUD、播放/暂停、
        // 双击全屏），不再被 base-ui 非模态形态的 outside-press 收掉 —— 退回一级
        // 只留表头返回按钮与系统/手势返回两条路。
        //
        // 播放页把抽屉挂在侧栏 `DrawerViewport` 里（`scoped`），本组件的 `Drawer`
        // 此时传 `modal={false}`，base-ui 的 `outsidePress` 于是在非模态分支直接
        // 放行：任何落在抽屉与遮罩之外的点按都会关掉它，而播放器正是那个区域。
        //
        // Escape 与 close-press 不受它影响：Android 返回键经 `dismissTopmostPopup`
        // 派发的是合成 Escape，滑动关闭走 `store.setOpen`，两者照旧能收起抽屉。
        disablePointerDismissal={mobile}
        onOpenChange={(open) => {
          if (!open) setSelectedComment(null);
        }}
      >
        <DrawerContent
          side={repliesSide}
          className={cn(
            "flex flex-col overflow-hidden p-0",
            panelDrawerSizeClass(repliesSide, scoped),
          )}
        >
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
            <DrawerTitle>评论详情</DrawerTitle>
            <DrawerClose
              render={
                <Button variant="ghost" size="icon" aria-label="返回评论区" title="返回评论区">
                  {/* 箭头指向抽屉退出的方向：底部形态往下收，侧边形态往右收。 */}
                  {repliesSide === "bottom" ? <ChevronDown /> : <ChevronRight />}
                </Button>
              }
            />
          </div>
          {selectedComment && mobile && (
            <CommentReplies
              key={selectedComment.rpid}
              aid={aid}
              comment={selectedComment}
              bottomInset={repliesSide === "bottom" ? bottomInset : undefined}
            />
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
