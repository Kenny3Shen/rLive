import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronDown,
  Eye,
  MessageCircle,
  Play,
  Users,
  ListMusic,
  Video,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorState } from "@/shared/components/ErrorState";
import { LinkText } from "@/shared/components/LinkText";
import { CARD_SURFACE_CLASS } from "@/shared/components/cardSurface";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import { isMobileClient } from "@/shared/clientPlatform";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import type {
  SeasonEpisode,
  VideoArchive,
  VideoArchivePage,
  VideoSeason,
  VideoUgcSeason,
} from "@/shared/types/video";
import type { VideoDanmakuEntry } from "./videoDanmaku";
import { CommentsPanel } from "./CommentsPanel";
import { VideoCommentComposer } from "./VideoCommentComposer";
import { VideoDanmakuList } from "./VideoDanmakuList";
import { VideoCard } from "./VideoCard";
import { videoGetArchive, videoGetOnlineTotal, videoGetRelated, videoGetSeason } from "./videoApi";
import { formatDateTime, formatVideoDuration } from "./videoHistory";
import { videoPlayPath, videoSearchPath } from "./videoRoute";
import {
  dedupeVideoItems,
  playlistItemFromVideoItem,
  playlistItemFromArchivePage,
  playlistItemFromPgcEpisode,
  playlistItemFromSeasonEpisode,
  usePlaylistStore,
  type PlaylistItem,
} from "./playlistStore";
import { filterBlockedUploaders } from "./videoUploaderBlock";
import { useVideoBlockedUploaders } from "./useVideoBlockedUploaders";
import { videoSelectionDefaultOpen } from "./videoSelectionDefaults";
import { DanmakuSettingsPanel } from "@/features/room/DanmakuSettingsPanel";
import { UploaderDrawer } from "./UploaderDrawer";

/**
 * 播放页右侧栏：相关视频（含信息卡、分集 / 选集 / 合集）、评论、弹幕与设置。
 *
 * 一个文件装下多种列表是刻意的 —— 它们共享同一套「信息卡 + 滚动容器 + 行项」骨架，
 * 拆成多个文件只会让这个骨架复制多遍。相关视频、分集与选集上游都是一次给全；
 * 唯一有翻页的评论区已拆到 `CommentsPanel.tsx`，因为短视频竖屏舞台也要用它，
 * 而那个表面用不上这里的相关视频 / 分集 / 选集 / 弹幕设置。
 */
export type SidebarTab = "related" | "danmaku" | "comments" | "settings";

const TAB_LABELS: Record<SidebarTab, string> = {
  related: "相关视频",
  danmaku: "弹幕",
  comments: "评论",
  settings: "设置",
};

const SIDEBAR_TABS: readonly SidebarTab[] = ["related", "danmaku", "comments", "settings"];

function isSidebarTab(value: string): value is SidebarTab {
  return (SIDEBAR_TABS as readonly string[]).includes(value);
}

/**
 * 稿件详情未落定时的 UP 主信息卡骨架。
 *
 * 几何与真卡逐项对齐（`section` 的 `px-2.5 py-2`、卡壳的 `rounded-xl` + 同底同描边、
 * 40px 头像、名称行 `pr-16`、标题行的 `mt-1.5` + 24px、统计行的 `mt-0.5` + 16px），
 * 数据到达时只有内容替换、不重新排布。
 *
 * 必须和真卡一样画在「相关视频」面板里：UP 主卡属于内容区而不是页签之外，
 * 所以首屏加载时它是列表的第一块 —— 从前只在 `archive` 到位后才渲染，移动端冷启动
 * （`archive` 与 `related` 同时 pending）会先看到一条没有 UP 主卡的相关列表，
 * 数据到达后整块内容再被往下推一次。
 */
function UpCardSkeleton() {
  return (
    <section
      data-slot="video-up-card-skeleton"
      aria-hidden
      // 与真卡一致：不带下分割线。
      className="shrink-0 px-2.5 py-2"
    >
      <div className="overflow-hidden rounded-xl border border-border-subtle bg-card/75 px-2.5 py-2 shadow-sm">
        <div className="flex min-w-0 items-start gap-2.5 pr-16">
          {/* 头像按 `Avatar size="lg"` 的实际渲染尺寸（40px）：真卡的 `size-11`
              与 `data-[size=lg]:size-10` 同时存在时后者胜出，因此量到的是 40。 */}
          <Skeleton className="size-10 shrink-0 rounded-full ring-1 ring-border/80" />
          <div className="min-w-0 flex-1">
            {/* 名称行与粉丝/视频行：真卡是 20px 名称 + 4px 间距 + 16px 元信息。 */}
            <Skeleton className="h-5 w-32" />
            <div className="mt-0.5 flex items-center gap-2">
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-12" />
            </div>
          </div>
        </div>
        {/* 标题行：真卡是 20px 一行标题，行高 24px（行盒 + 上下 2px）。 */}
        <Skeleton className="mt-1.5 h-6 w-4/5" />
        {/* 统计行（播放/评论/发布时间/当前在线）。 */}
        <div className="mt-0.5 flex items-center gap-x-2">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-14" />
        </div>
      </div>
    </section>
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
  // 相关视频按稿件组织而不是按作者，但屏蔽名单仍是「这个人的东西我不想看」，
  // 因此一并过滤；被屏蔽的条目不影响后续的「连播相关视频」（它同样走这里）。
  const blockedUploaders = useVideoBlockedUploaders();
  const items = filterBlockedUploaders(
    dedupeVideoItems(relatedQuery.data?.items.filter((item) => item.bvid !== bvid) ?? []),
    blockedUploaders,
  );
  const playlistItems = items.map(playlistItemFromVideoItem);

  return (
    <div data-slot="video-related-list" className="px-3 pb-4">
      {relatedQuery.isPending ? (
        <div className="flex flex-col gap-1 pt-1.5">
          {[0, 1, 2].map((index) => (
            // 与行式 VideoCard 同几何与同表面：卡片底色 + 细描边，封面占 2/5 列宽，
            // 右侧三行文本。
            <div
              key={index}
              className={cn("flex items-start gap-2.5 rounded-xl p-1.5", CARD_SURFACE_CLASS)}
            >
              <Skeleton className="aspect-video w-2/5 shrink-0 rounded-md ring-1 ring-border-subtle" />
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
        // 卡片现在自带底色，行与行之间必须留缝：紧贴时相邻两张卡的底色连成一整块，
        // 反而比透明卡片更读不出边界。间距与上面的骨架一致，数据到达时列表不跳。
        <div className="flex flex-col gap-1 pt-1.5">
          {items.map((item) => (
            <VideoCard
              key={`${item.bvid}-${item.cid ?? ""}`}
              item={item}
              playlist={playlistItems}
              playlistKind="feed"
              orientation="row"
              coverAspect="landscape"
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 分集/合集/选集三种列表共用的行画法：左列集号（或序数、P 号），中间标题，
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

/**
 * 只调整选集自身的有限高列表。scrollIntoView 会同时滚动祖先，信息卡移到
 * 同一页签后会把卡片甚至视频挤出视口；直接设置本层 scrollTop 不会产生这种副作用。
 */
function useCurrentRowScroll(active: boolean | undefined, currentKey: string | number) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const currentRowRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const list = listRef.current;
    const row = currentRowRef.current;
    if (!list || !row) return;
    const rowRect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    list.scrollTop += rowRect.top - listRect.top - (list.clientHeight - rowRect.height) / 2;
  }, [active, currentKey]);

  return { listRef, currentRowRef };
}

/**
 * 三类选集共用标题开关；收起时移除内容并立即退出焦点序列。
 *
 * 每个选集区自成一张卡片（与上方 UP 主信息卡同一套描边/底色/圆角）：
 * 选集行与相关视频行都是「封面或序号 + 标题」的列表，不包一层时两段列表
 * 首尾相接，读不出合集在哪里结束、相关推荐从哪里开始。
 */
function SelectionSection({
  label,
  title,
  count,
  open,
  onOpenChange,
  className,
  children,
}: {
  label: string;
  title?: string;
  count: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 卡片外侧间距由所在面板决定。 */
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      render={
        <section
          data-slot="video-selection-card"
          className={cn(
            "shrink-0 overflow-hidden rounded-xl border border-border-subtle bg-card/75 shadow-sm",
            className,
          )}
        />
      }
      aria-label={title ? `${label}：${title}` : label}
    >
      <h3>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="h-auto w-full min-w-0 justify-start gap-2 rounded-none px-3 py-2"
            />
          }
        >
          <ChevronDown
            aria-hidden
            data-icon="inline-start"
            className={cn("transition-transform", !open && "-rotate-90")}
          />
          <span className="shrink-0">{label}</span>
          {title && <span className="min-w-0 flex-1 truncate text-left">{title}</span>}
          <span className="ml-auto shrink-0 font-normal tabular-nums text-muted-foreground">
            {count}
          </span>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent inert={!open || undefined}>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** 当前剧集信息来自 season 接口，不请求或伪造 PGC 相关视频流。 */
function SeasonInfoCard({
  season,
  episode,
}: {
  season: VideoSeason;
  episode: SeasonEpisode | null;
}) {
  return (
    <section className="shrink-0 px-2.5 py-2" aria-label="当前剧集信息">
      <Card size="sm">
        <CardHeader>
          <CardTitle>{season.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {episode && (
            <p className="font-medium">
              {[episode.title, episode.long_title].filter(Boolean).join(" · ")}
            </p>
          )}
          <p className="text-muted-foreground">
            共 {season.episodes.length} 集
            {episode && episode.duration > 0 && ` · ${formatVideoDuration(episode.duration)}`}
          </p>
          {season.evaluate && <p className="line-clamp-3">{season.evaluate}</p>}
        </CardContent>
      </Card>
    </section>
  );
}

/** 分集列表（PGC），置于当前剧集信息卡下方。 */
function EpisodesPanel({
  epId,
  episodes,
  active,
  onNavigate,
}: {
  epId: string;
  episodes: SeasonEpisode[];
  active: boolean;
  onNavigate: (target: {
    bvid: string;
    cid: number;
    epId: string;
    title: string;
    aid: string;
  }) => void;
}) {
  const [open, setOpen] = useState(() =>
    videoSelectionDefaultOpen("episodes", { mobile: isMobileClient() }),
  );
  const { listRef, currentRowRef } = useCurrentRowScroll(open && active, epId);
  const playlistStore = usePlaylistStore();

  // 分集列表与播放页共用同一份转换，避免两处映射漂移。
  const playlistItems: PlaylistItem[] = episodes.map(playlistItemFromPgcEpisode);

  // 播放全部：从第一集开始
  const handlePlayAll = () => {
    const firstItem = playlistItems[0];
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
    <SelectionSection
      label="分集"
      count={`共 ${episodes.length} 集`}
      open={open}
      onOpenChange={setOpen}
      className="mx-2.5 mb-2"
    >
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
        </div>
      )}

      <div
        ref={listRef}
        data-video-selection-list="episodes"
        className="max-h-64 overflow-y-auto overscroll-contain px-2 pb-2 touch-pan-y"
      >
        {episodes.map((episode, index) => (
          <EpisodeRow
            key={episode.ep_id}
            current={episode.ep_id === epId}
            rowRef={episode.ep_id === epId ? currentRowRef : undefined}
            label={episode.title || "·"}
            title={episode.long_title || episode.title}
            duration={episode.duration}
            onNavigate={() => {
              playlistStore.setPlaylist(playlistItems, playlistItems[index].id, "sequence");
              onNavigate({
                bvid: episode.bvid,
                cid: episode.cid,
                epId: episode.ep_id,
                title: episode.long_title || episode.title,
                aid: episode.aid,
              });
            }}
          />
        ))}
      </div>
    </SelectionSection>
  );
}

/**
 * UGC 合集列表。只展示不接管队列，点任意分集时才切换为合集连播列表。
 */
function UgcSeasonPanel({
  season,
  currentBvid,
  active,
  defaultOpen,
  onNavigate,
}: {
  season: VideoUgcSeason;
  /** 链接可能没带 cid，以 bvid 定位当前项。 */
  currentBvid: string;
  /** 相关视频页签是否选中；非活动时列表不做定位滚动。 */
  active?: boolean;
  /** 默认展开状态，见 `videoSelectionDefaultOpen`。 */
  defaultOpen: boolean;
  onNavigate: (target: {
    bvid: string;
    cid: number;
    title: string;
    aid: string;
    epId?: string;
  }) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <SelectionSection
      label="合集"
      title={season.title}
      count={`共 ${season.episodes.length} 个`}
      open={open}
      onOpenChange={setOpen}
    >
      <UgcSeasonList
        season={season}
        currentBvid={currentBvid}
        active={open && active}
        onNavigate={onNavigate}
      />
    </SelectionSection>
  );
}

/** 合集条目列表：单独成组件，使每次展开都按当前稿件定位内部列表。 */
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
   * 相关视频是否为当前选中页签。非活动时不做定位滚动：用户没在看这一页，
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
  const { listRef, currentRowRef } = useCurrentRowScroll(active, currentBvid);

  return (
    <div
      ref={listRef}
      data-video-selection-list="season"
      className="max-h-64 overflow-y-auto overscroll-contain px-2 pb-2 touch-pan-y"
    >
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
  defaultOpen,
  onNavigate,
}: {
  bvid: string;
  aid: string;
  pages: VideoArchivePage[];
  /** 链接缺 cid（搜索进入）时定位不到当前项，不高亮。 */
  currentCid: number;
  /** 相关视频是否为当前选中页签；非活动时不做定位滚动。 */
  active?: boolean;
  /** 默认展开状态，见 `videoSelectionDefaultOpen`。 */
  defaultOpen: boolean;
  onNavigate: (target: {
    bvid: string;
    cid: number;
    title: string;
    aid: string;
    epId?: string;
  }) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { listRef, currentRowRef } = useCurrentRowScroll(open && active, currentCid);

  return (
    <SelectionSection
      label="选集"
      count={`共 ${pages.length} P`}
      open={open}
      onOpenChange={setOpen}
    >
      <div
        ref={listRef}
        data-video-selection-list="parts"
        className="max-h-64 overflow-y-auto overscroll-contain px-2 pb-2 touch-pan-y"
      >
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
    </SelectionSection>
  );
}

/**
 * 信息卡下方的选集与合集区域；默认展开策略见 `videoSelectionDefaultOpen`（移动端一律收起）。
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
  /** 相关视频页签是否选中；向下传给两份列表，非活动时不做定位滚动。 */
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
  // 仅挂载时取值：面板按稿件 key 重挂，同稿件换 P 不重算，保留手动折叠状态。
  const mobile = isMobileClient();

  return (
    <section className="flex shrink-0 flex-col gap-2 px-2.5 pt-2" aria-label="视频选集与合集">
      {multiPart && (
        <PartsPanel
          bvid={archive.bvid}
          aid={archive.aid}
          pages={archive.pages}
          currentCid={currentCid}
          active={active}
          defaultOpen={videoSelectionDefaultOpen("parts", { mobile })}
          onNavigate={onNavigate}
        />
      )}
      {season && (
        <UgcSeasonPanel
          season={season}
          currentBvid={currentBvid}
          active={active}
          defaultOpen={videoSelectionDefaultOpen("season", { mobile, multiPart })}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}

export function VideoSidebar({
  bvid,
  epId,
  aid,
  cid,
  danmaku,
  danmakuComposer,
  tab: requestedTab,
  onTabChange,
  detailsContentRef,
  onSeek,
}: {
  bvid: string | null;
  epId: string | null;
  aid: string | null;
  tab: SidebarTab | null;
  onTabChange: (tab: SidebarTab) => void;
  /** 当前播放的 cid：多 P 稿件的选集列表用它高亮当前 P。 */
  cid: number;
  /** 评论空降到当前视频的播放位置（秒），与弹幕是否开启无关。 */
  onSeek?: (seconds: number) => void;
  /** 弹幕查看列表数据：播放页已加载的条目 + 当前进度 + 点击跳转。 */
  danmaku?: {
    entries: readonly VideoDanmakuEntry[];
    positionMs: number;
    loading: boolean;
    /** 点击条目跳到该弹幕出现的播放位置（毫秒）。 */
    onSeek: (positionMs: number) => void;
  };
  /** 移动端竖屏的弹幕发送框，固定在弹幕页签底部，由播放页决定是否提供。 */
  danmakuComposer?: ReactNode;
  /** 仅内容视口参与自适应占比，Tab 栏不绑定调整手势。 */
  detailsContentRef?: Ref<HTMLDivElement>;
}) {
  const navigate = useNavigate();
  const isPgc = Boolean(epId);
  const [uploaderDrawerOpen, setUploaderDrawerOpen] = useState(false);
  // 简介默认收起（卡片不先露出简介）；换稿件时由 UP 信息卡 section 上按 bvid 生成的 key 重挂载复位。
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
  // 简介与 Tags 至少有一项时标题才是可展开的开关；两者都没有时标题只是标题。
  const hasArchiveDetail = Boolean(archive?.desc || archive?.tags.length);
  const multiPart = !isPgc && (archive?.pages.length ?? 0) > 0;
  // 合集 / 分集 / 多 P 统一在相关视频的信息卡下，不再占独立页签。
  const showDanmakuTab = danmaku !== undefined;
  const hasSeason = Boolean(archive?.ugc_season);
  const tabs: SidebarTab[] = ["related", "comments", "danmaku", "settings"];
  const visibleTabs = showDanmakuTab ? tabs : tabs.filter((t) => t !== "danmaku");
  // 没有弹幕数据时无弹幕页签；请求的页签不存在时回退到相关视频。
  const tab: SidebarTab =
    requestedTab && visibleTabs.includes(requestedTab)
      ? requestedTab
      : (visibleTabs[0] ?? "comments");

  // 在线数按当前分 P 独立刷新，不复用 archive 的五分钟缓存，也不显示上一集数据。
  const onlineQuery = useQuery({
    queryKey: ["video_online_total", bvid ?? "", cid],
    enabled: !isPgc && Boolean(bvid) && cid > 0 && tab === "related",
    queryFn: () => videoGetOnlineTotal(bvid!, cid),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });

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
      return (
        <>
          <div
            data-slot="video-sidebar-comments-list"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y"
          >
            {resolvedAid ? (
              <CommentsPanel key={resolvedAid} aid={resolvedAid} onSeek={onSeek} />
            ) : (
              <div className="px-3 py-6">
                {(isPgc ? seasonQuery.isPending : archiveQuery.isPending) ? (
                  <Spinner className="mx-auto size-4" aria-label="正在加载" />
                ) : (
                  <ErrorState
                    error={new Error("没有取到评论区的稿件信息。")}
                    title="评论不可用"
                    onRetry={() => void (isPgc ? seasonQuery.refetch() : archiveQuery.refetch())}
                  />
                )}
              </div>
            )}
          </div>
          <VideoCommentComposer aid={resolvedAid} />
        </>
      );
    }
    if (value === "danmaku") {
      if (!danmaku) return null;
      return (
        <>
          <div className="min-h-0 flex-1">
            <VideoDanmakuList
              // 按 cid 重挂：换视频后跟随状态不应沿用。
              key={cid}
              entries={danmaku.entries}
              positionMs={danmaku.positionMs}
              loading={danmaku.loading}
              onSeek={danmaku.onSeek}
              active={value === tab}
            />
          </div>
          {danmakuComposer && (
            <div data-slot="video-sidebar-danmaku-composer" className="shrink-0">
              {danmakuComposer}
            </div>
          )}
        </>
      );
    }
    if (value === "settings") {
      // 与直播侧栏「设置」页签同源的面板；VOD 不渲染语音字幕卡
      //（本地字幕设置项直接显示在播放器字幕菜单中）。
      return <DanmakuSettingsPanel className="h-full" showAsrCard={false} />;
    }
    if (isPgc) {
      if (seasonQuery.isPending) return <UpCardSkeleton />;
      if (seasonQuery.isError) {
        return (
          <ErrorState
            error={seasonQuery.error}
            title="剧集加载失败"
            onRetry={() => void seasonQuery.refetch()}
          />
        );
      }
      const season = seasonQuery.data;
      return (
        <>
          <SeasonInfoCard season={season} episode={currentEpisode} />
          <EpisodesPanel
            key={season.season_id}
            epId={epId!}
            episodes={season.episodes}
            active={value === tab}
            onNavigate={navigateToPlay}
          />
        </>
      );
    }
    return (
      <>
        {!isPgc && archiveQuery.isPending && <UpCardSkeleton />}
        {!isPgc && archive && (
          <Collapsible
            // 与下方选集区同处一个 Fragment，key 必须带各自前缀：缓存命中时
            // `archive.bvid === bvid`，两者若都直接用 bvid 会撞成重复 key，
            // React 删不掉旧节点，切换合集稿件时 UP 卡会越积越多。
            key={`up-card:${bvid}`}
            open={descriptionExpanded}
            onOpenChange={setDescriptionExpanded}
            render={<section className="shrink-0 px-2.5 py-2" />}
            aria-label={`UP 主信息：${archive.author}`}
          >
            <div className="overflow-hidden rounded-xl border border-border-subtle bg-card/75 px-2.5 py-2 shadow-sm">
              {/* 右侧 pr-16 是预留位（关注/更多之类的操作），只留在头像+名称行， */}
              {/* 不影响下方标题行与统计行的可用宽度。 */}
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
              {/* 稿件标题一行，整行即简介/Tags 的展开-收起开关。

                  开关从统计行右端搬到标题上。旧实现是独立的图标按钮，走 shadcn
                  `Button` 的 `aria-expanded:bg-muted`：收起时透明、展开时亮一块灰底，
                  同一个按钮两种样子，收起态「有背景」正是它；整行开关不画底色，两端
                  一致。箭头跟在标题文字末尾（与短视频详情入口同一读法），短标题紧贴
                  文字、长标题截断后仍指得到，点击整行都能切换而不必瞄准小箭头。
                  没有简介也没有 Tags 时标题退化成不可点的普通一行（无从展开）。 */}
              {hasArchiveDetail ? (
                <CollapsibleTrigger
                  // 显式常驻 `aria-controls`：基料只在展开时挂它，而要求收起态也能
                  // 解析到目标（回归夹具与无障碍契约都按这一点写）。
                  aria-controls="video-description"
                  className="mt-1.5 flex min-h-6 w-full min-w-0 items-center text-left transition-opacity hover:opacity-80"
                >
                  {/* 内层 `w-fit` 让箭头跟着内容宽：短标题的箭头紧贴文字，
                      而不是隔着一大片空白飘在右边界。`items-end` + 箭头的
                      `mb-[3px]` 让它在标题换行后落在最后一行（单行时与垂直居中
                      同高），与短视频详情入口同一读法。 */}
                  <span className="flex w-fit max-w-full min-w-0 items-end gap-1">
                    <span
                      className={cn(
                        "min-w-0 text-sm leading-5 font-medium tracking-tight",
                        // 收起时单行截断（卡片保持紧凑、骨架几何不变）；展开时让标题
                        // 换行显示完全体 —— 展开的简介里读得到全文，标题也应当读得到。
                        // 展开后不再需要 `title` 提示（文字已经全部可见）。
                        descriptionExpanded ? "break-words" : "truncate",
                      )}
                      title={descriptionExpanded ? undefined : archive.title}
                    >
                      {archive.title}
                    </span>
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "mb-[3px] size-3.5 shrink-0 text-muted-foreground transition-transform",
                        descriptionExpanded && "rotate-180",
                      )}
                    />
                  </span>
                </CollapsibleTrigger>
              ) : (
                <p
                  className="mt-1.5 flex min-h-6 items-center truncate text-sm leading-5 font-medium tracking-tight"
                  title={archive.title}
                >
                  {archive.title}
                </p>
              )}
              {/* 在线数紧跟发布时间；完整日期与人数由 title 保留，窄侧栏优先收窄累计统计。 */}
              <dl className="mt-0.5 flex min-w-0 items-center gap-x-2 overflow-hidden text-[11px] leading-4 text-muted-foreground">
                <div
                  className="flex min-w-0 shrink-[3] items-center gap-1"
                  title={`播放：${formatOnline(archive.view)}`}
                >
                  <dt className="sr-only">播放</dt>
                  <Play aria-hidden className="size-3 shrink-0" />
                  <dd className="truncate tabular-nums">{formatOnline(archive.view)}</dd>
                </div>
                <div
                  className="flex min-w-0 shrink-[3] items-center gap-1"
                  title={`评论：${formatOnline(archive.reply)}`}
                >
                  <dt className="sr-only">评论</dt>
                  {/*
                    评论一律用圆气泡 `MessageCircle`，方形 `MessageSquare*` 留给弹幕。
                    这两件事在本项目里到处并列出现（播放页侧栏、短视频底栏），
                    靠形状区分比靠位置区分可靠。
                  */}
                  <MessageCircle aria-hidden className="size-3 shrink-0" />
                  <dd className="truncate tabular-nums">{formatOnline(archive.reply)}</dd>
                </div>
                {archive.pubdate > 0 && (
                  <div
                    className="flex min-w-0 shrink-[0.5] items-center gap-1"
                    title={`视频发布时间：${formatDateTime(archive.pubdate)}`}
                  >
                    <dt className="sr-only">发布时间</dt>
                    <CalendarDays aria-hidden className="size-3 shrink-0" />
                    <dd className="truncate tabular-nums">{formatDateTime(archive.pubdate)}</dd>
                  </div>
                )}
                {onlineQuery.data != null && !onlineQuery.isError && (
                  <div
                    className="flex min-w-0 shrink-0 items-center gap-1"
                    title={`当前在线人数：${onlineQuery.data}`}
                  >
                    <dt className="sr-only">当前在线人数</dt>
                    <Eye aria-hidden className="size-3 shrink-0" />
                    <dd className="tabular-nums">{onlineQuery.data}</dd>
                  </div>
                )}
              </dl>
              {/* 简介默认不展开：`keepMounted` 让收起态仍留在 DOM 里（`hidden`），
                  `aria-controls` 因此始终能解析到目标；`--collapsible-panel-height`
                  是基料量出的当前高度，过渡它就能得到可中断的展开/收起动画。
                  Tags 跟在正文末尾，点击进入对应的视频搜索结果。 */}
              {hasArchiveDetail && (
                <CollapsibleContent
                  id="video-description"
                  keepMounted
                  className={cn(
                    "h-(--collapsible-panel-height) overflow-hidden",
                    "transition-[height] duration-150 ease-[var(--motion-ease-out)]",
                    "motion-reduce:transition-none",
                    // 两端都从/到 0 高：起始帧与结束帧由属性钩子给，避免首次
                    // 测量前先闪一帧全高。
                    "data-starting-style:h-0 data-ending-style:h-0",
                  )}
                >
                  <div className="mt-2">
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
                </CollapsibleContent>
              )}
            </div>
          </Collapsible>
        )}
        {archive && (multiPart || hasSeason) && (
          <PartsSeasonPanel
            // 换稿件复位两份列表的默认展开策略；同稿件换 P 不重挂，保留手动收起态。
            key={`selection:${archive.bvid}`}
            archive={archive}
            currentCid={cid}
            currentBvid={bvid ?? ""}
            active={value === tab}
            onNavigate={navigateToPlay}
          />
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
      {/* Tab 栏只负责点按/横滑切换，纵向滑动不调整布局。 */}
      <div className="flex h-11 shrink-0 items-center border-b border-border/80">
        <TabsList
          variant="line"
          className="h-11! min-w-0 flex-1 justify-start rounded-none bg-transparent px-2"
        >
          {visibleTabs.map((value) => (
            <TabsTrigger key={value} value={value} className="px-3 text-sm">
              {TAB_LABELS[value]}
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
      <div
        ref={detailsContentRef}
        data-video-side-tab-viewport
        className="relative min-h-0 flex-1 overflow-clip"
      >
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
              aria-label={TAB_LABELS[value]}
              aria-hidden={value === tab ? undefined : true}
              inert={value === tab ? undefined : true}
              data-video-side-tab-panel={value}
              className={cn(
                "flex min-h-0 min-w-0 shrink-0 flex-col",
                // 弹幕与评论的列表独立滚动，发送区固定在底部，外壳不能再套一层
                // 纵向滚动；其余页签是普通文档流内容，由外壳负责滚动。
                //
                // `touch-pan-y` 必须写在滚动容器自己身上，不能只靠 Tabs 外壳那一层：
                // Chromium 用命中元素所在的**最近滚动容器**决定手势归属，容器为默认
                // `touch-action: auto` 时横向拖动会被合成器当作滚动接走，第一次
                // pointermove 之后就派发 pointercancel，横滑因此永远攒不到锁定阈值。
                value === "danmaku" || value === "comments"
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
