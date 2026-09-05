import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  MessageSquare,
  MessageSquareText,
  Play,
  ThumbsUp,
  ListOrdered,
  Shuffle,
  ListMusic,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorState } from "@/shared/components/ErrorState";
import { ImageViewer } from "@/shared/components/ImageViewer";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { cn, formatOnline, normalizeImageUrl, normalizeVideoCoverUrl } from "@/lib/utils";
import type {
  VideoArchive,
  VideoArchivePage,
  VideoComment,
  VideoUgcSeason,
} from "@/shared/types/video";
import type { VideoDanmakuEntry } from "./videoDanmaku";
import { VideoDanmakuList } from "./VideoDanmakuList";
import {
  videoGetArchive,
  videoGetCommentReplies,
  videoGetComments,
  videoGetRelated,
  videoGetSeason,
} from "./videoApi";
import { formatVideoDuration } from "./VideoCard";
import { videoPlayPath } from "./videoRoute";
import { usePlaylistStore, type PlaylistItem } from "./playlistStore";
import { UploaderDrawer } from "./UploaderDrawer";

/**
 * 播放页右侧栏：相关视频（UGC）/ 分集（PGC）/ 选集（多 P）/ 合集与评论区。
 *
 * 一个文件装下多种列表是刻意的 —— 它们共享同一套「页签 + 滚动容器 + 行项」骨架，
 * 拆成多个文件只会让这个骨架复制多遍。评论区是其中唯一有翻页的，用游标
 * `useInfiniteQuery` + 哨兵；相关视频、分集与选集上游都是一次给全。
 */
type SidebarTab = "related" | "danmaku" | "episodes" | "parts" | "comments";

const TAB_LABELS: Record<SidebarTab, string> = {
  related: "相关视频",
  danmaku: "弹幕",
  episodes: "分集",
  parts: "选集",
  comments: "评论",
};

const SIDEBAR_TABS: readonly SidebarTab[] = ["related", "danmaku", "episodes", "parts", "comments"];

function isSidebarTab(value: string): value is SidebarTab {
  return (SIDEBAR_TABS as readonly string[]).includes(value);
}

/** 页签标签：parts 页签在仅有合集（无分 P）时显示为「合集」。 */
function sidebarTabLabel(value: SidebarTab, multiPart: boolean): string {
  if (value === "parts") return multiPart ? "选集" : "合集";
  return TAB_LABELS[value];
}

/** Unix 秒 → 「x 分钟前」。超过一个月退回日期，足够读评不用更准。 */
function formatRelativeTime(unixSec: number): string {
  const diff = Math.max(0, Date.now() / 1000 - unixSec);
  if (diff < 60) return "刚刚";
  if (diff < 3_600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86_400) return `${Math.floor(diff / 3_600)} 小时前`;
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)} 天前`;
  const date = new Date(unixSec * 1_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** 把 `[大哭]` 这类占位符换成内联表情图。 */
function renderCommentMessage(message: string, emotes: VideoComment["emotes"]): ReactNode {
  if (emotes.length === 0 || !message) return message;
  const parts: ReactNode[] = [];
  let rest = message;
  let key = 0;
  while (rest) {
    let hit: { index: number; text: string; url: string } | null = null;
    for (const emote of emotes) {
      const index = rest.indexOf(emote.text);
      if (index !== -1 && (!hit || index < hit.index)) {
        hit = { index, text: emote.text, url: emote.url };
      }
    }
    if (!hit) {
      parts.push(rest);
      break;
    }
    if (hit.index > 0) parts.push(rest.slice(0, hit.index));
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

function CommentBody({ comment }: { comment: VideoComment }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  const handleImageClick = (index: number) => {
    setViewerIndex(index);
    setViewerOpen(true);
  };

  return (
    <>
      <p className="whitespace-pre-line break-words text-[13px] leading-relaxed">
        {renderCommentMessage(comment.message, comment.emotes)}
      </p>
      {comment.pictures.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {comment.pictures.map((src, index) => (
            <button
              key={src}
              type="button"
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

function CommentRow({ comment }: { comment: VideoComment }) {
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
          {comment.level > 0 && (
            <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
              Lv{comment.level}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatRelativeTime(comment.ctime)}
        </div>
        <div className="mt-1">
          <CommentBody comment={comment} />
        </div>
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <ThumbsUp className="size-3" aria-hidden />
          <span>{formatOnline(comment.like)}</span>
        </div>
      </div>
    </div>
  );
}

/** 一条一级评论 + 可展开的二级回复。 */
function CommentThread({ aid, comment }: { aid: string; comment: VideoComment }) {
  const [expanded, setExpanded] = useState(false);
  const repliesQuery = useInfiniteQuery({
    queryKey: ["video_comment_replies", aid, comment.rpid],
    enabled: expanded,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => videoGetCommentReplies(aid, comment.rpid, pageParam),
    getNextPageParam: (lastPage, _, lastPageParam) =>
      lastPage.has_more ? lastPageParam + 1 : undefined,
  });
  // 主接口自带的预览（前 2-3 条）先展示，翻页结果按 rpid 去重后接在后面。
  const fetched = repliesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const previewRpids = new Set(comment.replies.map((reply) => reply.rpid));
  const replies = [...comment.replies, ...fetched.filter((reply) => !previewRpids.has(reply.rpid))];
  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    hasNextPage: repliesQuery.hasNextPage,
    isFetchingNextPage: repliesQuery.isFetchingNextPage,
    isFetchNextPageError: repliesQuery.isFetchNextPageError,
    fetchNextPage: () => repliesQuery.fetchNextPage(),
  });

  return (
    <div className="border-b border-border/60 py-3 last:border-b-0">
      <CommentRow comment={comment} />
      {comment.rcount > 0 && (
        <div className="mt-1 pl-10.5">
          <button
            type="button"
            className="text-xs text-primary/90 hover:underline"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起回复" : `展开 ${comment.rcount} 条回复`}
          </button>
          {expanded && (
            <div className="mt-2 flex flex-col gap-2.5 rounded-lg bg-muted/40 p-2.5">
              {repliesQuery.isPending && comment.replies.length === 0 ? (
                <Spinner className="mx-auto size-4" aria-label="正在加载回复" />
              ) : repliesQuery.isError && replies.length === 0 ? (
                <p className="text-xs text-muted-foreground">回复加载失败</p>
              ) : (
                replies.map((reply) => <CommentRow key={reply.rpid} comment={reply} />)
              )}
              <div ref={loadMoreRef}>
                {repliesQuery.isFetchingNextPage && (
                  <Spinner className="mx-auto size-4" aria-label="正在加载更多回复" />
                )}
                {!supportsIntersectionObserver &&
                  repliesQuery.hasNextPage &&
                  !repliesQuery.isFetchingNextPage && (
                    <Button variant="ghost" size="sm" className="w-full" onClick={() => loadMore()}>
                      加载更多回复
                    </Button>
                  )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 评论列表：排序切换 + 游标翻页。 */
function CommentsPanel({ aid }: { aid: string }) {
  const [mode, setMode] = useState(3);
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
    hasNextPage: commentsQuery.hasNextPage,
    isFetchingNextPage: commentsQuery.isFetchingNextPage,
    isFetchNextPageError: commentsQuery.isFetchNextPageError,
    fetchNextPage: () => commentsQuery.fetchNextPage(),
  });
  const sortModes: [number, string][] = [
    [3, "最热"],
    [2, "最新"],
  ];

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="text-xs text-muted-foreground">
          {allCount > 0 ? `共 ${formatOnline(allCount)} 条` : "评论"}
        </span>
        <div className="flex gap-1">
          {sortModes.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs transition-colors",
                mode === value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70",
              )}
            >
              {label}
            </button>
          ))}
        </div>
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
      ) : commentsQuery.isError ? (
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
            <CommentThread key={comment.rpid} aid={aid} comment={comment} />
          ))}
          <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center">
            {commentsQuery.isFetchingNextPage && (
              <Spinner className="size-4" aria-label="正在加载更多评论" />
            )}
            {!supportsIntersectionObserver &&
              commentsQuery.hasNextPage &&
              !commentsQuery.isFetchingNextPage && (
                <Button variant="ghost" size="sm" onClick={() => loadMore()}>
                  加载更多
                </Button>
              )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 相关视频（UGC）。 */
function RelatedPanel({
  bvid,
  onNavigate,
}: {
  bvid: string;
  onNavigate: (target: { bvid: string; cid: number; title: string; aid: string }) => void;
}) {
  const relatedQuery = useQuery({
    queryKey: ["video_related", bvid],
    enabled: bvid !== "",
    queryFn: () => videoGetRelated(bvid),
    staleTime: 5 * 60_000,
  });
  const items = relatedQuery.data?.items.filter((item) => item.bvid !== bvid) ?? [];

  return (
    <div className="px-3 pb-4">
      {relatedQuery.isPending ? (
        <div className="flex flex-col gap-3 pt-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex gap-2.5">
              <Skeleton className="aspect-video w-40 shrink-0 rounded-md" />
              <div className="flex w-full flex-col gap-1.5 py-0.5">
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
        items.map((item) => {
          const playable = typeof item.cid === "number" && item.cid > 0;
          const content = (
            <>
              <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-md bg-muted">
                <img
                  src={normalizeVideoCoverUrl(item.cover)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="size-full object-cover"
                />
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] font-medium tabular-nums text-white">
                  {formatVideoDuration(item.duration)}
                </span>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
                <p className="line-clamp-2 text-[13px] font-medium leading-snug">{item.title}</p>
                <p className="truncate text-xs text-muted-foreground">{item.author}</p>
                <p className="text-[11px] text-muted-foreground/85">
                  {formatOnline(item.view)} 播放 · {formatOnline(item.danmaku)} 弹幕
                </p>
              </div>
            </>
          );
          if (!playable) {
            return (
              <div
                key={`${item.bvid}-${item.cid ?? ""}`}
                aria-label={item.title}
                className="flex gap-2.5 py-2 opacity-60"
              >
                {content}
              </div>
            );
          }
          return (
            <button
              key={`${item.bvid}-${item.cid ?? ""}`}
              type="button"
              aria-label={`${item.title}，UP 主 ${item.author}`}
              onClick={() =>
                onNavigate({
                  bvid: item.bvid,
                  cid: item.cid!,
                  title: item.title,
                  aid: item.aid,
                })
              }
              className="flex w-full gap-2.5 rounded-lg py-2 text-left transition-colors hover:bg-muted/50"
            >
              {content}
            </button>
          );
        })
      )}
    </div>
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
    playlistStore.setPlaylist(playlistItems, firstItem.id);
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
    playlistStore.setPlaylist(playlistItems, currentItem.id);
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
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
          episodes.map((episode) => {
            const current = episode.ep_id === epId;
            return (
              <button
                key={episode.ep_id}
                type="button"
                aria-current={current || undefined}
                onClick={() =>
                  onNavigate({
                    bvid: episode.bvid,
                    cid: episode.cid,
                    epId: episode.ep_id,
                    title: episode.long_title || episode.title,
                    aid: episode.aid,
                  })
                }
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
                  {episode.title || "·"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {episode.long_title || episode.title}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatVideoDuration(episode.duration)}
                </span>
              </button>
            );
          })
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
  onNavigate,
}: {
  season: VideoUgcSeason;
  /** 链接可能没带 cid，以 bvid 定位当前项。 */
  currentBvid: string;
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
      <UgcSeasonList season={season} currentBvid={currentBvid} onNavigate={onNavigate} />
    </div>
  );
}

/** 合集条目列表：`UgcSeasonPanel` 的列表部分，也供选集页签内的折叠合集复用。 */
function UgcSeasonList({
  season,
  currentBvid,
  onNavigate,
}: {
  season: VideoUgcSeason;
  /** 链接可能没带 cid，以 bvid 定位当前项。 */
  currentBvid: string;
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
    currentRowRef.current?.scrollIntoView({ block: "center" });
  }, [currentBvid]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      {season.episodes.map((episode, index) => {
        const current = episode.bvid === currentBvid;
        return (
          <button
            key={episode.bvid}
            ref={current ? currentRowRef : undefined}
            type="button"
            aria-current={current || undefined}
            onClick={() =>
              onNavigate({
                bvid: episode.bvid,
                cid: episode.cid,
                title: episode.title,
                aid: episode.aid,
              })
            }
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
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{episode.title}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatVideoDuration(episode.duration)}
            </span>
          </button>
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
  onNavigate,
}: {
  bvid: string;
  aid: string;
  pages: VideoArchivePage[];
  /** 链接缺 cid（搜索进入）时定位不到当前项，不高亮。 */
  currentCid: number;
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
    if (open) currentRowRef.current?.scrollIntoView({ block: "center" });
  }, [currentCid, open]);

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
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {pages.map((page) => {
            const current = currentCid > 0 && page.cid === currentCid;
            const label = page.part || `P${page.page}`;
            return (
              <button
                key={page.cid}
                ref={current ? currentRowRef : undefined}
                type="button"
                aria-current={current || undefined}
                onClick={() =>
                  onNavigate({
                    bvid,
                    cid: page.cid,
                    title: label,
                    aid,
                  })
                }
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
                  P{page.page}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatVideoDuration(page.duration)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 选集与合集共用一个页签的内容面板：多 P 稿件展开选集、合集默认收起
 * （两者同时存在时选集优先——连播沿分 P 列表走）；仅有合集时直接展开
 * 合集（此时页签标签显示为「合集」）。
 */
function PartsSeasonPanel({
  archive,
  currentCid,
  currentBvid,
  onNavigate,
}: {
  archive: VideoArchive;
  currentCid: number;
  currentBvid: string;
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
            <UgcSeasonList season={season} currentBvid={currentBvid} onNavigate={onNavigate} />
          )}
        </section>
      )}
      {season && !multiPart && (
        <UgcSeasonPanel season={season} currentBvid={currentBvid} onNavigate={onNavigate} />
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
}: {
  bvid: string | null;
  epId: string | null;
  aid: string | null;
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
  const [tab, setTab] = useState<SidebarTab>(isPgc ? "episodes" : "related");
  const [uploaderDrawerOpen, setUploaderDrawerOpen] = useState(false);
  const [descriptionState, setDescriptionState] = useState<{
    bvid: string | null;
    expanded: boolean;
  }>({ bvid: null, expanded: false });
  const descriptionExpanded = descriptionState.bvid === bvid && descriptionState.expanded;
  // 用户手动切换过页签后就不再自动改选，见下方的自动切换 effect。
  const tabTouchedRef = useRef(false);

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
  // 弹幕页签固定在最右；选集与合集共用 parts 页签（见 PartsSeasonPanel）。
  const showDanmakuTab = !isPgc && danmaku !== undefined;
  const hasSeason = Boolean(archive?.ugc_season);
  const tabs: SidebarTab[] = isPgc
    ? ["episodes", "comments"]
    : multiPart
      ? ["parts", "related", "comments", "danmaku"]
      : hasSeason
        ? ["related", "comments", "parts", "danmaku"]
        : ["related", "comments", "danmaku"];
  const visibleTabs = showDanmakuTab ? tabs : tabs.filter((t) => t !== "danmaku");

  // 多 P 稿件默认展示选集（与 B 站 Web 同款落点）：详情取回后把未动过页签的
  // 侧栏切到「选集」；用户已手动切换过则不再干预。
  useEffect(() => {
    if (multiPart && !tabTouchedRef.current && tab !== "parts") {
      setTab("parts");
    }
  }, [multiPart, tab]);

  const handleUploaderClick = () => {
    if (archive?.author_mid) {
      setUploaderDrawerOpen(true);
    }
  };

  return (
    // 与直播播放页右侧栏同一套结构：UP 主信息卡（sideHeader 的对应物）在页签
    // 之上，即整页右上角；页签条是 line 变体 Tabs + h-11 条带（见 PlayerPane）。
    <Tabs
      value={tab}
      className="flex h-full min-h-0 flex-col gap-0"
      onValueChange={(value) => {
        if (isSidebarTab(value)) {
          tabTouchedRef.current = true;
          setTab(value);
        }
      }}
    >
      {/* UP 主信息块：与直播页的主播信息（RoomHostInfo）同一套画法（sideHeader
          的对应物，置于页签之上即整页右上角）—— 圆角卡片包裹、共享 Avatar、
          分隔线统计行；简介仅宽屏侧栏展示，窄屏与直播页主播卡同构同高。 */}
      {!isPgc && archive && (
        <section
          className="shrink-0 border-b border-border px-2.5 py-2"
          aria-label={`UP 主信息：${archive.author}`}
        >
          <div className="overflow-hidden rounded-xl border border-border-subtle bg-card/75 px-2.5 py-2 shadow-sm">
            <div className="flex min-w-0 items-center gap-2.5">
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
                  className="block w-full text-left transition-opacity hover:opacity-80"
                  aria-label={`查看 ${archive.author} 的投稿视频`}
                >
                  <p
                    className="truncate text-sm font-semibold leading-5 tracking-tight"
                    title={archive.author}
                  >
                    {archive.author}
                  </p>
                </button>
                <dl className="mt-1.5 flex min-w-0 items-center text-xs leading-4">
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
                    title={`弹幕：${formatOnline(archive.danmaku)}`}
                  >
                    <dt className="sr-only">弹幕</dt>
                    <MessageSquare
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <dd className="font-semibold leading-4 tracking-normal tabular-nums">
                      {formatOnline(archive.danmaku)}
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
                </dl>
              </div>
            </div>
            {archive.desc && (
              <div className="mt-2 max-lg:hidden">
                <p
                  id="video-description"
                  className={cn(
                    "whitespace-pre-line text-xs leading-relaxed text-muted-foreground",
                    !descriptionExpanded && "line-clamp-2",
                  )}
                >
                  {archive.desc}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-expanded={descriptionExpanded}
                  aria-controls="video-description"
                  className="mt-0.5 h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setDescriptionState((state) => ({
                      bvid,
                      expanded: state.bvid === bvid ? !state.expanded : true,
                    }))
                  }
                >
                  {descriptionExpanded ? "收起简介" : "展开简介"}
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "size-3.5 transition-transform",
                      descriptionExpanded && "rotate-180",
                    )}
                  />
                </Button>
              </div>
            )}
          </div>
        </section>
      )}
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {tab === "comments" ? (
          resolvedAid ? (
            <CommentsPanel aid={resolvedAid} />
          ) : (
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
          )
        ) : tab === "episodes" ? (
          <EpisodesPanel epId={epId!} onNavigate={navigateToPlay} />
        ) : tab === "parts" && archive && (multiPart || hasSeason) ? (
          <PartsSeasonPanel
            archive={archive}
            currentCid={cid}
            currentBvid={bvid ?? ""}
            onNavigate={navigateToPlay}
          />
        ) : tab === "danmaku" && danmaku ? (
          <VideoDanmakuList
            entries={danmaku.entries}
            positionMs={danmaku.positionMs}
            loading={danmaku.loading}
            onSeek={danmaku.onSeek}
          />
        ) : (
          <RelatedPanel bvid={bvid ?? ""} onNavigate={navigateToPlay} />
        )}
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
