import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ArrowUpDown,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  MessageSquareText,
  Play,
  ThumbsUp,
  ListOrdered,
  Users,
  Shuffle,
  ListMusic,
  Video,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorState } from "@/shared/components/ErrorState";
import { ImageViewer } from "@/shared/components/ImageViewer";
import { LinkText } from "@/shared/components/LinkText";
import { LoadMoreRow } from "@/shared/components/LoadMoreRow";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import { isMobileClient } from "@/shared/clientPlatform";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import type {
  VideoArchive,
  VideoArchivePage,
  VideoComment,
  VideoUgcSeason,
} from "@/shared/types/video";
import type { VideoDanmakuEntry } from "./videoDanmaku";
import { VideoDanmakuList } from "./VideoDanmakuList";
import { VideoCard } from "./VideoCard";
import {
  videoGetArchive,
  videoGetCommentReplies,
  videoGetComments,
  videoGetRelated,
  videoGetSeason,
} from "./videoApi";
import { formatDateTime, formatRelativeTime, formatVideoDuration } from "./videoHistory";
import { videoPlayPath, videoSearchPath } from "./videoRoute";
import {
  dedupeVideoItems,
  playlistItemFromVideoItem,
  playlistItemFromArchivePage,
  playlistItemFromSeasonEpisode,
  usePlaylistStore,
  type PlaylistItem,
} from "./playlistStore";
import { DanmakuSettingsPanel } from "@/features/room/DanmakuSettingsPanel";
import { UploaderDrawer } from "./UploaderDrawer";

/**
 * 播放页右侧栏：相关视频（UGC）/ 分集（PGC）/ 选集（多 P）/ 合集与评论区。
 *
 * 一个文件装下多种列表是刻意的 —— 它们共享同一套「页签 + 滚动容器 + 行项」骨架，
 * 拆成多个文件只会让这个骨架复制多遍。评论区是其中唯一有翻页的，用游标
 * `useInfiniteQuery` + 哨兵；相关视频、分集与选集上游都是一次给全。
 */
export type SidebarTab = "related" | "danmaku" | "episodes" | "parts" | "comments" | "settings";

const TAB_LABELS: Record<SidebarTab, string> = {
  related: "相关视频",
  danmaku: "弹幕",
  episodes: "分集",
  parts: "选集",
  comments: "评论",
  settings: "设置",
};

const SIDEBAR_TABS: readonly SidebarTab[] = [
  "related",
  "danmaku",
  "episodes",
  "parts",
  "comments",
  "settings",
];

function isSidebarTab(value: string): value is SidebarTab {
  return (SIDEBAR_TABS as readonly string[]).includes(value);
}

/** 页签标签：parts 页签在仅有合集（无分 P）时显示为「合集」。 */
function sidebarTabLabel(value: SidebarTab, multiPart: boolean): string {
  if (value === "parts") return multiPart ? "选集" : "合集";
  return TAB_LABELS[value];
}

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
          {isThreadAuthor && <Badge variant="secondary">楼主</Badge>}
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
        <span className="text-muted-foreground">： </span>
        <span className="text-foreground/80">
          {renderCommentMessage(reply.message, reply.emotes)}
        </span>
        {reply.pictures.length > 0 && <span className="text-muted-foreground"> [图片]</span>}
      </span>
    </button>
  );
}

/** 一条一级评论与 PiliPlus 风格的二级回复预览。 */
function CommentThread({
  comment,
  onOpenDetail,
}: {
  comment: VideoComment;
  onOpenDetail: () => void;
}) {
  const previewReplies = comment.replies.slice(0, 3);

  return (
    <div className="border-b border-border/60 py-3 last:border-b-0">
      <CommentRow comment={comment} onOpenDetail={onOpenDetail} />
      {(comment.rcount > 0 || previewReplies.length > 0) && (
        <div className="mt-2 pl-10.5">
          <div className="overflow-hidden rounded-md bg-muted/40 py-1">
            {previewReplies.map((reply) => (
              <ReplyPreview key={reply.rpid} reply={reply} onOpenDetail={onOpenDetail} />
            ))}
            {previewReplies.length < comment.rcount && (
              <button
                type="button"
                className="w-full px-2 py-1.5 text-left text-xs text-primary/90 hover:bg-muted/70"
                onClick={onOpenDetail}
              >
                共 {formatOnline(comment.rcount)} 条回复
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CommentReplies({ aid, comment }: { aid: string; comment: VideoComment }) {
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
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
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
function CommentsPanel({ aid }: { aid: string }) {
  const [mode, setMode] = useState(3);
  const [selectedComment, setSelectedComment] = useState<VideoComment | null>(null);
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
              comment={comment}
              onOpenDetail={() => setSelectedComment(comment)}
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
        open={selectedComment !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedComment(null);
        }}
      >
        <DrawerContent side="right" className="flex h-full flex-col overflow-hidden p-0">
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
            <DrawerTitle>评论详情</DrawerTitle>
            <DrawerClose
              render={
                <Button variant="ghost" size="icon" aria-label="返回评论区" title="返回评论区">
                  <ChevronRight />
                </Button>
              }
            />
          </div>
          {selectedComment && (
            <CommentReplies key={selectedComment.rpid} aid={aid} comment={selectedComment} />
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}

/** 相关视频（UGC）。 */
function RelatedPanel({ bvid }: { bvid: string }) {
  const relatedQuery = useQuery({
    queryKey: ["video_related", bvid],
    enabled: bvid !== "",
    queryFn: () => videoGetRelated(bvid),
    staleTime: 5 * 60_000,
  });
  const items = dedupeVideoItems(
    relatedQuery.data?.items.filter((item) => item.bvid !== bvid) ?? [],
  );
  const playlistItems = items.map(playlistItemFromVideoItem);

  return (
    <div className="px-3 pb-4">
      {relatedQuery.isPending ? (
        <div className="flex flex-col gap-1 pt-1.5">
          {[0, 1, 2].map((index) => (
            // 与行式 VideoCard 同几何：封面占 2/5 列宽，右侧三行文本。
            <div key={index} className="flex items-start gap-2.5 p-1.5">
              <Skeleton className="aspect-video w-2/5 shrink-0 rounded-md" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
          ))}
        </div>
      ) : relatedQuery.isError ? (
        <ErrorState
          error={relatedQuery.error}
          title="相关视频加载失败"
          onRetry={() => void relatedQuery.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="pt-4 text-center text-xs text-muted-foreground">暂无相关视频</p>
      ) : (
        items.map((item) => (
          <VideoCard
            key={`${item.bvid}-${item.cid ?? ""}`}
            item={item}
            playlist={playlistItems}
            playlistKind="feed"
            orientation="row"
          />
        ))
      )}
    </div>
  );
}

/**
 * 分集/合集/选集三种页签共用的行画法：左列集号（或序数、P 号），中间标题，
 * 右侧时长；当前播放项高亮，点击整行跳转。三种列表只差数据来源与左列文案。
 */
function EpisodeRow({
  current,
  label,
  title,
  duration,
  rowRef,
  onNavigate,
}: {
  current: boolean;
  /** 左列：集号 / 序数 / P 号。 */
  label: string;
  title: string;
  /** 时长，秒。 */
  duration: number;
  /** 当前播放行：挂上后由列表滚动定位到可视区中央。 */
  rowRef?: Ref<HTMLButtonElement>;
  onNavigate: () => void;
}) {
  return (
    <button
      ref={rowRef}
      type="button"
      aria-current={current || undefined}
      onClick={onNavigate}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/50",
        current && "bg-primary/10",
      )}
    >
      <span
        className={cn(
          "min-w-7 shrink-0 text-center text-xs tabular-nums",
          current ? "font-semibold text-primary" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {formatVideoDuration(duration)}
      </span>
    </button>
  );
}

/** 分集列表（PGC）。 */
function EpisodesPanel({
  epId,
  onNavigate,
}: {
  epId: string;
  onNavigate: (target: {
    bvid: string;
    cid: number;
    epId: string;
    title: string;
    aid: string;
  }) => void;
}) {
  const seasonQuery = useQuery({
    queryKey: ["video_season", "", epId],
    queryFn: () => videoGetSeason({ epId }),
    staleTime: 5 * 60_000,
  });
  const episodes = seasonQuery.data?.episodes ?? [];
  const playlistStore = usePlaylistStore();

  // 将分集列表转换为播放列表项
  const playlistItems: PlaylistItem[] = episodes.map((episode) => ({
    id: `${episode.bvid}_${episode.cid}`,
    bvid: episode.bvid,
    cid: episode.cid,
    epId: episode.ep_id,
    aid: episode.aid,
    title: episode.long_title || episode.title,
    index: episode.title || "",
    duration: episode.duration,
    cover: episode.cover,
  }));

  // 播放全部：从第一集开始
  const handlePlayAll = () => {
    if (playlistItems.length === 0) return;
    const firstItem = playlistStore.reversed
      ? playlistItems[playlistItems.length - 1]
      : playlistItems[0];
    if (!firstItem) return;
    playlistStore.setPlaylist(playlistItems, firstItem.id, "sequence");
    onNavigate({
      bvid: firstItem.bvid,
      cid: firstItem.cid,
      epId: firstItem.epId!,
      title: firstItem.title,
      aid: firstItem.aid,
    });
  };

  // 继续播放：从当前集开始设置播放列表
  const handleContinuePlay = () => {
    if (playlistItems.length === 0) return;
    const currentItem = playlistItems.find((item) => item.epId === epId);
    if (!currentItem) return;
    playlistStore.setPlaylist(playlistItems, currentItem.id, "sequence");
  };

  return (
    <div className="flex min-h-0 flex-col">
      {/* 播放控制栏 */}
      {episodes.length > 1 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-2 py-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={handlePlayAll}
                >
                  <Play className="size-3.5" />
                  <span>播放全部</span>
                </Button>
              }
            />
            <TooltipContent>从第一集开始播放</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={handleContinuePlay}
                >
                  <ListMusic className="size-3.5" />
                  <span>加入列表</span>
                </Button>
              }
            />
            <TooltipContent>从当前集开始播放列表</TooltipContent>
          </Tooltip>

          <div className="flex-1" />

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "size-8 shrink-0",
                    playlistStore.reversed && "bg-primary/10 text-primary",
                  )}
                  onClick={() => playlistStore.toggleReversed()}
                  aria-pressed={playlistStore.reversed}
                >
                  {playlistStore.reversed ? (
                    <ListOrdered className="size-4" />
                  ) : (
                    <Shuffle className="size-4" />
                  )}
                </Button>
              }
            />
            <TooltipContent>{playlistStore.reversed ? "正序播放" : "倒序播放"}</TooltipContent>
          </Tooltip>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 touch-pan-y">
        {seasonQuery.isPending ? (
          <div className="flex flex-col gap-2 pt-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-11 w-full rounded-lg" />
            ))}
          </div>
        ) : seasonQuery.isError ? (
          <ErrorState
            error={seasonQuery.error}
            title="分集加载失败"
            onRetry={() => void seasonQuery.refetch()}
          />
        ) : (
          episodes.map((episode) => (
            <EpisodeRow
              key={episode.ep_id}
              current={episode.ep_id === epId}
              label={episode.title || "·"}
              title={episode.long_title || episode.title}
              duration={episode.duration}
              onNavigate={() =>
                onNavigate({
                  bvid: episode.bvid,
                  cid: episode.cid,
                  epId: episode.ep_id,
                  title: episode.long_title || episode.title,
                  aid: episode.aid,
                })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * UGC 合集列表。合集接管播放列表后，这份列表就是当前连播列表的具象：
 * 点任意分集即跳转，无需「播放全部」（播放页已自动把合集设为播放列表）。
 */
function UgcSeasonPanel({
  season,
  currentBvid,
  active,
  onNavigate,
}: {
  season: VideoUgcSeason;
  /** 链接可能没带 cid，以 bvid 定位当前项。 */
  currentBvid: string;
  /** 本页签是否选中；非活动时列表不做定位滚动。 */
  active?: boolean;
  onNavigate: (target: {
    bvid: string;
    cid: number;
    title: string;
    aid: string;
    epId?: string;
  }) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-baseline gap-2 border-b border-border/50 px-3 py-2">
        <span className="min-w-0 truncate text-xs font-medium">{season.title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          共 {season.episodes.length} 个
        </span>
      </div>
      <UgcSeasonList
        season={season}
        currentBvid={currentBvid}
        active={active}
        onNavigate={onNavigate}
      />
    </div>
  );
}

/** 合集条目列表：`UgcSeasonPanel` 的列表部分，也供选集页签内的折叠合集复用。 */
function UgcSeasonList({
  season,
  currentBvid,
  active,
  onNavigate,
}: {
  season: VideoUgcSeason;
  /** 链接可能没带 cid，以 bvid 定位当前项。 */
  currentBvid: string;
  /**
   * 本面板是否为当前选中页签。非活动时不做定位滚动：用户没在看这一页，
   * 而连播换集会在后台改 `currentBvid`。与 `VideoDanmakuList` 的 `active` 同义。
   */
  active?: boolean;
  onNavigate: (target: {
    bvid: string;
    cid: number;
    title: string;
    aid: string;
    epId?: string;
  }) => void;
}) {
  const currentRowRef = useRef<HTMLButtonElement | null>(null);

  // 打开合集页签或连播换集时，把当前播放项滚到可视区中央：长合集（几十上百集）
  // 默认停在顶部，正在看的那集可能在视口外。仅滚动列表容器，不抖动外层。
  useEffect(() => {
    if (!active) return;
    currentRowRef.current?.scrollIntoView({ block: "center" });
  }, [active, currentBvid]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 touch-pan-y">
      {season.episodes.map((episode, index) => {
        const current = episode.bvid === currentBvid;
        return (
          <EpisodeRow
            key={episode.bvid}
            current={current}
            label={String(index + 1)}
            title={episode.title}
            duration={episode.duration}
            rowRef={current ? currentRowRef : undefined}
            onNavigate={() => {
              const items = season.episodes.map(playlistItemFromSeasonEpisode);
              usePlaylistStore.getState().setPlaylist(items, items[index].id, "sequence");
              onNavigate({
                bvid: episode.bvid,
                cid: episode.cid,
                title: episode.title,
                aid: episode.aid,
              });
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * 多 P 选集列表。与合集面板同构：当前播放项按 cid 高亮并滚动到可视区，
 * 点任意 P 即跳转，连播沿分 P 列表走。标题行即收起开关（与合集折叠行
 * 同款画法）：左侧「选集」、右侧「共 x P」，点按整行切换列表显隐。
 */
function PartsPanel({
  bvid,
  aid,
  pages,
  currentCid,
  active,
  onNavigate,
}: {
  bvid: string;
  aid: string;
  pages: VideoArchivePage[];
  /** 链接缺 cid（搜索进入）时定位不到当前项，不高亮。 */
  currentCid: number;
  /** 本面板是否为当前选中页签；非活动时不做定位滚动。 */
  active?: boolean;
  onNavigate: (target: {
    bvid: string;
    cid: number;
    title: string;
    aid: string;
    epId?: string;
  }) => void;
}) {
  const currentRowRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(true);

  // 打开选集页签或换 P 时把正在播的那 P 滚到可视区中央（与合集面板同一策略）；
  // 收起后再展开也重新定位，长列表不至于回到顶部找不到当前 P。
  useEffect(() => {
    if (open && active) currentRowRef.current?.scrollIntoView({ block: "center" });
  }, [active, currentCid, open]);

  return (
    <div className="flex min-h-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-muted/50"
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span className="shrink-0">选集</span>
        <span className="ml-auto shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
          共 {pages.length} P
        </span>
      </button>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 touch-pan-y">
          {pages.map((page) => {
            const current = currentCid > 0 && page.cid === currentCid;
            const label = page.part || `P${page.page}`;
            return (
              <EpisodeRow
                key={page.cid}
                current={current}
                label={`P${page.page}`}
                title={label}
                duration={page.duration}
                rowRef={current ? currentRowRef : undefined}
                onNavigate={() => {
                  usePlaylistStore.getState().setPlaylist(
                    pages.map((entry) => playlistItemFromArchivePage(bvid, aid, entry)),
                    `${bvid}_${page.cid}`,
                    "sequence",
                  );
                  onNavigate({ bvid, cid: page.cid, title: label, aid });
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 选集与合集共用一个页签的内容面板：多 P 稿件展开选集、合集默认收起。
 * 只有显式点选才切换相应队列，单纯展示不接管来源列表。
 */
function PartsSeasonPanel({
  archive,
  currentCid,
  currentBvid,
  active,
  onNavigate,
}: {
  archive: VideoArchive;
  currentCid: number;
  currentBvid: string;
  /** 本页签是否选中；向下传给两份列表，非活动时不做定位滚动。 */
  active?: boolean;
  onNavigate: (target: {
    bvid: string;
    cid: number;
    title: string;
    aid: string;
    epId?: string;
  }) => void;
}) {
  const multiPart = archive.pages.length > 0;
  const season = archive.ugc_season;
  const [seasonOpen, setSeasonOpen] = useState(!multiPart);

  return (
    <div>
      {multiPart && (
        // key 换稿件即重挂：选集收起态不跨稿件沿用 —— 每个多 P 稿件进来都
        // 是默认展开的列表（与页签自动切到「选集」同一落点），同一稿件内
        // 换 P（连播/点行跳转）不重挂、收起态保持。
        <PartsPanel
          key={archive.bvid}
          bvid={archive.bvid}
          aid={archive.aid}
          pages={archive.pages}
          currentCid={currentCid}
          active={active}
          onNavigate={onNavigate}
        />
      )}
      {season && multiPart && (
        <section className="border-t border-border/60" aria-label={`合集：${season.title}`}>
          <button
            type="button"
            aria-expanded={seasonOpen}
            onClick={() => setSeasonOpen((value) => !value)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-muted/50"
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                !seasonOpen && "-rotate-90",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{season.title}</span>
            <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
              共 {season.episodes.length} 个
            </span>
          </button>
          {seasonOpen && (
            <UgcSeasonList
              season={season}
              currentBvid={currentBvid}
              active={active}
              onNavigate={onNavigate}
            />
          )}
        </section>
      )}
      {season && !multiPart && (
        <UgcSeasonPanel
          season={season}
          currentBvid={currentBvid}
          active={active}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

export function VideoSidebar({
  bvid,
  epId,
  aid,
  cid,
  danmaku,
  tab: requestedTab,
  onTabChange,
}: {
  bvid: string | null;
  epId: string | null;
  aid: string | null;
  tab: SidebarTab | null;
  onTabChange: (tab: SidebarTab) => void;
  /** 当前播放的 cid：多 P 稿件的选集页签用它高亮当前 P。 */
  cid: number;
  /** 弹幕查看列表数据：播放页已加载的条目 + 当前进度 + 点击跳转。 */
  danmaku?: {
    entries: readonly VideoDanmakuEntry[];
    positionMs: number;
    loading: boolean;
    /** 点击条目跳到该弹幕出现的播放位置（毫秒）。 */
    onSeek: (positionMs: number) => void;
  };
}) {
  const navigate = useNavigate();
  const isPgc = Boolean(epId);
  const [uploaderDrawerOpen, setUploaderDrawerOpen] = useState(false);
  // 简介默认收起（卡片不先露出简介）；换稿件时由 UP 信息卡 section 上的 key={bvid} 重挂载复位。
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  // 稿件详情：UGC 的评论区 oid 兜底 + 相关视频页签顶部的作者/统计信息。
  const archiveQuery = useQuery({
    queryKey: ["video_archive", bvid ?? ""],
    enabled: !isPgc && Boolean(bvid),
    queryFn: () => videoGetArchive(bvid!),
    staleTime: 5 * 60_000,
  });
  // PGC：分集表同时给当前集的 aid（评论 oid）。
  const seasonQuery = useQuery({
    queryKey: ["video_season", "", epId ?? ""],
    enabled: isPgc,
    queryFn: () => videoGetSeason({ epId: epId! }),
    staleTime: 5 * 60_000,
  });
  const currentEpisode =
    seasonQuery.data?.episodes.find((episode) => episode.ep_id === epId) ?? null;
  const resolvedAid =
    aid || (!isPgc ? archiveQuery.data?.aid : undefined) || currentEpisode?.aid || "";

  const navigateToPlay = (target: {
    bvid: string;
    cid: number;
    epId?: string;
    title: string;
    aid: string;
  }) => {
    navigate(videoPlayPath({ ...target, epId: target.epId ?? null }));
  };

  const archive = archiveQuery.data;
  const multiPart = !isPgc && (archive?.pages.length ?? 0) > 0;
  // 弹幕页签仅在 UGC 且播放页传入弹幕数据时出现；选集/合集（parts）固定在最右。
  const showDanmakuTab = !isPgc && danmaku !== undefined;
  const hasSeason = Boolean(archive?.ugc_season);
  const tabs: SidebarTab[] = isPgc
    ? ["episodes", "comments", "settings"]
    : multiPart || hasSeason
      ? ["related", "comments", "danmaku", "parts", "settings"]
      : ["related", "comments", "danmaku", "settings"];
  const visibleTabs = showDanmakuTab ? tabs : tabs.filter((t) => t !== "danmaku");
  // 请求的页签在当前稿件不存在时回退到第一项（PGC 无「相关推荐」、单 P 无「选集」、
  // 没有弹幕数据时无「弹幕」）。每种组合都含「评论」，故兜底取它。
  const tab: SidebarTab =
    requestedTab && visibleTabs.includes(requestedTab)
      ? requestedTab
      : (visibleTabs[0] ?? "comments");

  /**
   * 移动端左右滑动切页签，与直播间侧栏同一套算法与手感（`layout: "track"`）。
   *
   * `items` 必须传实际可见的页签而不是全集：条带按下标平移，PGC / 单 P / 无弹幕
   * 数据下多传一项就会整体错位。桌面不启用手势，但 hook 依然负责把条带停靠到
   * 选中页，因此点击切换在两端走同一条路径。
   */
  const {
    selectValue: selectSidebarTab,
    bindPage: sidebarSwipeBindPage,
    onPointerDownCapture: sidebarSwipeOnPointerDownCapture,
    onPointerMoveCapture: sidebarSwipeOnPointerMoveCapture,
    onPointerUpCapture: sidebarSwipeOnPointerUpCapture,
    onPointerCancelCapture: sidebarSwipeOnPointerCancelCapture,
    onClickCapture: sidebarSwipeOnClickCapture,
  } = useHorizontalSwipe({
    items: visibleTabs,
    value: tab,
    onChange: onTabChange,
    enabled: isMobileClient(),
    layout: "track",
  });

  const handleUploaderClick = () => {
    if (archive?.author_mid) {
      setUploaderDrawerOpen(true);
    }
  };

  /** 页签内容。所有页签常驻条带，因此按 value 取而不是只画当前一个。 */
  const sidebarPanel = (value: SidebarTab): ReactNode => {
    if (value === "comments") {
      if (resolvedAid) return <CommentsPanel key={resolvedAid} aid={resolvedAid} />;
      return (
        <div className="px-3 py-6">
          {archiveQuery.isPending || seasonQuery.isPending ? (
            <Spinner className="mx-auto size-4" aria-label="正在加载" />
          ) : (
            <ErrorState
              error={new Error("没有取到评论区的稿件信息。")}
              title="评论不可用"
              onRetry={() => void archiveQuery.refetch()}
            />
          )}
        </div>
      );
    }
    if (value === "episodes") return <EpisodesPanel epId={epId!} onNavigate={navigateToPlay} />;
    if (value === "parts") {
      if (!archive || !(multiPart || hasSeason)) return null;
      return (
        <PartsSeasonPanel
          archive={archive}
          currentCid={cid}
          currentBvid={bvid ?? ""}
          active={value === tab}
          onNavigate={navigateToPlay}
        />
      );
    }
    if (value === "danmaku") {
      if (!danmaku) return null;
      return (
        <VideoDanmakuList
          entries={danmaku.entries}
          positionMs={danmaku.positionMs}
          loading={danmaku.loading}
          onSeek={danmaku.onSeek}
          active={value === tab}
        />
      );
    }
    if (value === "settings") {
      // 与直播侧栏「设置」页签同源的面板；VOD 不渲染语音字幕卡
      //（本地字幕设置项直接显示在播放器字幕菜单中）。
      return <DanmakuSettingsPanel className="h-full" showAsrCard={false} />;
    }
    return (
      <>
        {!isPgc && archive && (
          <section
            key={bvid}
            className="shrink-0 border-b border-border px-2.5 py-2"
            aria-label={`UP 主信息：${archive.author}`}
          >
            <div className="overflow-hidden rounded-xl border border-border-subtle bg-card/75 px-2.5 py-2 shadow-sm">
              {/* 右侧 pr-16 是预留位（关注/更多之类的操作），只留在头像+名称行， */}
              {/* 不影响下方播放/评论/发布时间与简介开关那一行的可用宽度。 */}
              <div className="flex min-w-0 items-start gap-2.5 pr-16">
                <button
                  type="button"
                  onClick={handleUploaderClick}
                  aria-label={`查看 ${archive.author} 的投稿视频`}
                  className="shrink-0 transition-opacity hover:opacity-80"
                >
                  <Avatar size="lg" className="size-11 ring-1 ring-border/80">
                    <AvatarImage
                      src={normalizeImageUrl(archive.author_face)}
                      alt={`${archive.author} 的头像`}
                      referrerPolicy="no-referrer"
                    />
                    <AvatarFallback className="font-medium">
                      {Array.from(archive.author)[0] ?? "?"}
                    </AvatarFallback>
                  </Avatar>
                </button>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={handleUploaderClick}
                    className="block w-full min-w-0 text-left transition-opacity hover:opacity-80"
                    aria-label={`查看 ${archive.author} 的投稿视频`}
                  >
                    <p
                      className="truncate text-sm font-semibold leading-5 tracking-tight"
                      title={archive.author}
                    >
                      {archive.author}
                    </p>
                  </button>
                  <div className="mt-0.5 flex items-center gap-2 text-xs leading-4 text-muted-foreground">
                    <span
                      className="inline-flex items-center gap-1"
                      title={`粉丝：${formatOnline(archive.author_fans)}`}
                    >
                      <Users aria-hidden className="size-3.5" />
                      <span className="tabular-nums">{formatOnline(archive.author_fans)}</span>
                    </span>
                    <span
                      className="inline-flex items-center gap-1"
                      title={`视频：${formatOnline(archive.author_videos)}`}
                    >
                      <Video aria-hidden className="size-3.5" />
                      <span className="tabular-nums">{formatOnline(archive.author_videos)}</span>
                    </span>
                  </div>
                </div>
              </div>
              {/* 统计行与简介开关同排：侧栏（lg 320 / xl 340）下统计三项与图标开关的
                  开关单行放下；flex-wrap 兜底字体缩放与超长数值（发布时间换行而非
                  截断），发布时间组因此不加 border-l，避免换行后出现孤立竖线。 */}
              <div className="mt-1.5 flex min-w-0 items-center gap-1">
                <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-y-0.5 text-xs leading-4">
                  <div
                    className="flex min-w-0 items-center gap-1"
                    title={`播放：${formatOnline(archive.view)}`}
                  >
                    <dt className="sr-only">播放</dt>
                    <Play aria-hidden className="size-3.5 shrink-0 text-accent" />
                    <dd className="truncate font-semibold leading-4 tracking-normal tabular-nums">
                      {formatOnline(archive.view)}
                    </dd>
                  </div>
                  <div
                    className="ml-2.5 flex shrink-0 items-center gap-1 border-l border-border-subtle pl-2.5"
                    title={`评论：${formatOnline(archive.reply)}`}
                  >
                    <dt className="sr-only">评论</dt>
                    <MessageSquareText
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <dd className="font-semibold leading-4 tracking-normal tabular-nums">
                      {formatOnline(archive.reply)}
                    </dd>
                  </div>
                  {archive.pubdate > 0 && (
                    <div
                      className="ml-2.5 flex min-w-0 items-center gap-1 text-muted-foreground"
                      title="视频发布时间"
                    >
                      <dt className="sr-only">发布时间</dt>
                      <CalendarDays aria-hidden className="size-3.5 shrink-0" />
                      <dd className="truncate leading-4 tabular-nums">
                        {formatDateTime(archive.pubdate)}
                      </dd>
                    </div>
                  )}
                </dl>
                {(archive.desc || archive.tags.length > 0) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground"
                    aria-expanded={descriptionExpanded}
                    aria-controls="video-description"
                    aria-label={descriptionExpanded ? "收起视频简介" : "展开视频简介"}
                    title={descriptionExpanded ? "收起视频简介" : "展开视频简介"}
                    onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                  >
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "size-3.5 transition-transform",
                        descriptionExpanded && "rotate-180",
                      )}
                    />
                  </Button>
                )}
              </div>
              {/* 简介默认不展开：用 hidden 而非条件渲染，让 aria-controls 在收起态也能 */}
              {/* 解析到目标；Tags 跟在正文末尾，点击进入对应的视频搜索结果。 */}
              {(archive.desc || archive.tags.length > 0) && (
                <div id="video-description" hidden={!descriptionExpanded} className="mt-2">
                  {archive.desc && (
                    <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                      <LinkText text={archive.desc} />
                    </p>
                  )}
                  {archive.tags.length > 0 && (
                    <div
                      className={cn("flex flex-wrap gap-1.5", archive.desc && "mt-2")}
                      aria-label="视频 Tags"
                    >
                      {archive.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          render={<Link to={videoSearchPath(tag)} />}
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
        <RelatedPanel bvid={bvid ?? ""} />
      </>
    );
  };

  return (
    // 页签固定在右侧栏顶部；UP 主信息卡只并入「相关视频」内容区。
    <Tabs
      value={tab}
      data-horizontal-swipe-surface
      className="flex h-full min-h-0 flex-col gap-0 touch-pan-y overscroll-y-contain"
      onValueChange={(value) => {
        // 点击也走 selectValue：条带先开始平移，再通知状态更新，与拖动同一条路径。
        if (isSidebarTab(value)) selectSidebarTab(value);
      }}
      onPointerDownCapture={sidebarSwipeOnPointerDownCapture}
      onPointerMoveCapture={sidebarSwipeOnPointerMoveCapture}
      onPointerUpCapture={sidebarSwipeOnPointerUpCapture}
      onPointerCancelCapture={sidebarSwipeOnPointerCancelCapture}
      onClickCapture={sidebarSwipeOnClickCapture}
    >
      <div className="flex h-11 shrink-0 items-center border-b border-border/80">
        <TabsList
          variant="line"
          className="h-11! min-w-0 flex-1 justify-start rounded-none bg-transparent px-2"
        >
          {visibleTabs.map((value) => (
            <TabsTrigger key={value} value={value} className="px-3 text-sm">
              {sidebarTabLabel(value, multiPart)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {/* 页签内容常驻同一条带，按选中项整体平移：滑动时相邻页签已经绘制完成，
          手指下方是真实内容而不是切换后才挂载的空白。非活动页签用 aria-hidden +
          inert 退出无障碍树与焦点序列。纵向滚动交给每个页签自己那一层，
          条带与视口都不滚动，横滑与纵向浏览因此不争同一个指针。

          视口必须是 `overflow-clip` 而不是 `overflow-hidden`：`hidden` 仍然是滚动
          容器，只是不给用户滚动条，`scrollIntoView` 照样能滚它。条带宽 n×100%，
          非活动面板横向偏出视口，面板里任何 `scrollIntoView`（合集/选集定位当前项、
          弹幕跟随进度）都会让浏览器横向滚动本视口去「露出」那个偏移过的面板，条带
          于是停在页签之间，显示的面板与选中的页签脱同步（真机实测 scrollLeft 停在
          304.86px，非整数正是程序化滚动而非手势的特征）。`clip` 不建立滚动容器，
          这条不变量因此由布局本身保证，而不依赖每个面板都记得自我约束。 */}
      <div data-video-side-tab-viewport className="relative min-h-0 flex-1 overflow-clip">
        <div
          ref={sidebarSwipeBindPage}
          data-slot="horizontal-swipe-track"
          className="flex h-full min-w-0"
          style={{ width: `${visibleTabs.length * 100}%` }}
        >
          {visibleTabs.map((value) => (
            <div
              key={value}
              role="tabpanel"
              aria-label={sidebarTabLabel(value, multiPart)}
              aria-hidden={value === tab ? undefined : true}
              inert={value === tab ? undefined : true}
              data-video-side-tab-panel={value}
              className={cn(
                "flex min-h-0 min-w-0 shrink-0 flex-col",
                // 弹幕面板自持滚动视口（要独占滚动位置来跟随播放进度），外壳不能再套
                // 一层纵向滚动；其余页签是普通文档流内容，由外壳负责滚动。
                //
                // `touch-pan-y` 必须写在滚动容器自己身上，不能只靠 Tabs 外壳那一层：
                // Chromium 用命中元素所在的**最近滚动容器**决定手势归属，容器为默认
                // `touch-action: auto` 时横向拖动会被合成器当作滚动接走，第一次
                // pointermove 之后就派发 pointercancel，横滑因此永远攒不到锁定阈值。
                value === "danmaku"
                  ? "overflow-hidden"
                  : "overflow-y-auto overscroll-contain touch-pan-y",
              )}
              style={{ width: `${100 / visibleTabs.length}%` }}
            >
              {sidebarPanel(value)}
            </div>
          ))}
        </div>
      </div>

      {/* UP 主投稿抽屉 */}
      {archive && archive.author_mid && (
        <UploaderDrawer
          open={uploaderDrawerOpen}
          onOpenChange={setUploaderDrawerOpen}
          mid={archive.author_mid}
          uploaderName={archive.author}
        />
      )}
    </Tabs>
  );
}
