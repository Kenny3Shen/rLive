import { memo } from "react";
import type { RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, MessageSquareText, Play } from "lucide-react";
import { preloadRouteModule } from "@/app/routeModules";
import { Spinner } from "@/components/ui/spinner";
import { formatOnline, normalizeVideoCoverUrl, cn } from "@/lib/utils";
import { CARD_SURFACE_CLASS, CARD_SURFACE_HOVER_CLASS } from "@/shared/components/cardSurface";
import { videoCoverAspect } from "@/shared/videoDimension";
import type { PgcItem, VideoItem } from "@/shared/types/video";
import { useVideoCardPreview } from "./videoCardPreview";
import {
  usePlaylistStore,
  type PlaylistItem,
  type PlaylistKind,
  type PlaylistUploader,
} from "./playlistStore";
import { formatRelativeTime, formatVideoDuration } from "./videoHistory";
import { videoPlayPath } from "./videoRoute";
import { VideoMasonry } from "./VideoMasonry";

/**
 * 视频卡片。
 *
 * 与直播的 `RoomCard` 同一套画法（同样的圆角、封面比例、渐变与角标位置），但承载的
 * 事实不同：VOD 展示时长、播放量、弹幕数与 UP 主，直播展示热度与开播状态。因此是
 * 一个并列的组件而不是给 `RoomCard` 加分支 —— 那个组件还挂着关注、多画面、长按抽屉
 * 等一整套直播专属动作，VOD 一个都用不上。
 */

// 卡片自带底色与细描边（表面定义见 `shared/components/cardSurface.ts`，与直播
// `RoomCard`、关注页卡片共用）：瀑布流里相邻卡片只隔 12px，透明卡片的边界完全
// 由封面撑出，横竖画幅混排时读不出标题归属上一张还是下一张。
//
// 底色从封面自然向下延伸：封面满幅占住卡片顶部，卡片的圆角与描边正好落在封面边缘，
// 于是读作封面自己的边界继续包住下面的文字，而不是把封面又套进一层内边距。因此
// 外壳不带 padding，圆角/描边/投影整体上移到外壳 —— 原先挂在封面上的那一圈若留着，
// 会在卡片边界内侧再画一道，读成两层边框。
// 行式卡片是例外：文本块高于 16:9 缩略图且垂直居中，缩略图无法满幅，仍走内边距画法。
const CARD_CLASS = cn(
  "group flex w-full self-start flex-col overflow-hidden rounded-xl text-left",
  CARD_SURFACE_CLASS,
  CARD_SURFACE_HOVER_CLASS,
);
const COVER_CLASS = "relative w-full overflow-hidden bg-muted";
const COVER_IMAGE_CLASS =
  "absolute inset-0 h-full w-full object-cover transition-transform duration-200 ease-[var(--motion-ease-out)] motion-reduced:transition-none";
const BADGE_CLASS =
  "absolute inline-flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm";

/**
 * 卡片封面。`overlay` 里放角标，它们自己带绝对定位，因此堆在渐变之上。
 * `previewMount` / `previewLoading` 由 UGC 卡片传入（悬停预览，见
 * `videoCardPreview.ts`）；PGC 卡片不悬停预览（列表没有取流键，season 解析
 * 在播放页，悬停阶段无从取流），不传。
 */
function CoverImage({
  cover,
  overlay,
  previewMount,
  previewLoading,
  className,
  aspectRatio = 16 / 9,
}: {
  cover: string;
  overlay?: React.ReactNode;
  previewMount?: RefObject<HTMLDivElement | null>;
  previewLoading?: boolean;
  className?: string;
  aspectRatio?: number;
}) {
  const normalized = normalizeVideoCoverUrl(cover);
  return (
    <div
      data-slot="video-card-cover"
      className={cn(COVER_CLASS, className)}
      style={{ aspectRatio }}
    >
      {normalized ? (
        <img
          src={normalized}
          alt=""
          loading="lazy"
          decoding="sync"
          className={COVER_IMAGE_CLASS}
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
          暂无封面
        </div>
      )}
      {/* 预览盖在封面之上、渐变与角标之下（与直播卡同序）；挂载点不接收
          指针事件，悬停与点击始终落在卡片按钮上。 */}
      {previewMount && (
        <div ref={previewMount} aria-hidden className="pointer-events-none absolute inset-0" />
      )}
      {previewLoading && (
        <span className="pointer-events-none absolute left-2 top-2 inline-flex rounded-md bg-black/65 p-1 text-white backdrop-blur-sm">
          <Spinner className="size-3" />
        </span>
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent opacity-80" />
      {overlay}
    </div>
  );
}

export const VideoCard = memo(function VideoCard({
  item,
  playlist,
  playlistKind = "sequence",
  playlistUploader,
  onNavigate,
  orientation = "grid",
  coverAspect = "source",
  showAuthor = true,
}: {
  item: VideoItem;
  /** 列表上下文（搜索/UP 主投稿）：点击时把该列表设为播放列表，从这张卡开始连播。 */
  playlist?: readonly PlaylistItem[];
  playlistKind?: PlaylistKind;
  /** 队列来源 UP 标记：与 `playlist` 一起写入 store（UP 投稿抽屉连播），普通列表不传。 */
  playlistUploader?: PlaylistUploader | null;
  /** 队列写入后、路由跳转前回调（如关闭来源抽屉）。 */
  onNavigate?: () => void;
  /** `row`：缩略图在左、文本列在右（相关视频与 UP 主投稿列表）。 */
  orientation?: "grid" | "row";
  /** 默认遵循视频画幅；相关视频以 landscape 固定为 16:9 缩略图。 */
  coverAspect?: "source" | "landscape";
  /** 是否在发布日期旁显示 UP 主名；投稿抽屉按 PiliPlus 语义只显示发布日期。 */
  showAuthor?: boolean;
}) {
  const navigate = useNavigate();
  // 搜索与 UP 主空间列表的条目没有 cid：只要带 bvid 就可点，播放页用稿件详情
  // 补齐取流键（P1）。真正不可点的只剩无 bvid 的脏数据（后端已过滤，防御而已）。
  const playable = Boolean(item.bvid);
  const playPath = playable
    ? videoPlayPath({ bvid: item.bvid, cid: item.cid ?? null, title: item.title, aid: item.aid })
    : null;
  const preview = useVideoCardPreview({ bvid: item.bvid, cid: item.cid });
  const playListId = `${item.bvid}_${item.cid ?? 0}`;

  return (
    <button
      type="button"
      data-motion-press
      // 锚点带上 cid：推荐流会重复出现同一个 bvid（轮换批次），只用 bvid 的
      // 话返回时的锚点查找会命中第一张同名卡，把滚动恢复到错误位置。
      data-page-scroll-anchor={`video:${item.bvid}:${item.cid ?? ""}`}
      disabled={!playable}
      aria-label={`${item.title}，UP 主 ${item.author}，时长 ${formatVideoDuration(item.duration)}`}
      onPointerEnter={(event) => {
        if (playPath) preloadRouteModule(playPath);
        preview.onPointerEnter(event);
      }}
      onPointerLeave={preview.stop}
      onFocus={() => playPath && preloadRouteModule(playPath)}
      onClick={() => {
        if (!playPath) return;
        // 列表上下文保留点击时刻的快照；推荐流只供手动换片，不冒充下一集。
        if (playlist && playlist.some((entry) => entry.id === playListId)) {
          usePlaylistStore
            .getState()
            .setPlaylist([...playlist], playListId, playlistKind, playlistUploader);
        }
        onNavigate?.();
        navigate(playPath);
      }}
      className={cn(
        CARD_CLASS,
        // row 下缩略图与文本块垂直居中：侧栏里三行文本高于 16:9 封面，
        // 顶对齐会在封面下方留一段空白。缩略图因此不满幅，用内边距把它收进卡片。
        orientation === "row" && "flex-row items-center gap-2.5 p-1.5",
        !playable && "cursor-not-allowed opacity-60",
      )}
    >
      <CoverImage
        aspectRatio={coverAspect === "landscape" ? 16 / 9 : videoCoverAspect(item.dimension)}
        cover={item.cover}
        // 封面按列宽取比例而不是固定 w-40:侧栏只有 300px,固定宽度会把文本列
        // 挤到 90 px 出头，标题每行只剩几个字。行式缩略图不贴卡片边，自带圆角与描边。
        className={
          orientation === "row" ? "w-2/5 shrink-0 rounded-md ring-1 ring-border-subtle" : undefined
        }
        previewMount={preview.mountRef}
        previewLoading={preview.phase === "loading"}
        overlay={
          <>
            {/* 推荐理由是平台给的运营文案（如「百万播放」），放左上与右下的时长
                分开，两者都靠边而不互相挤。 */}
            {item.rcmd_reason && (
              <span
                data-mobile-static-backdrop
                className={cn(BADGE_CLASS, "left-2 top-2 max-w-[70%] truncate")}
              >
                {item.rcmd_reason}
              </span>
            )}
            <span
              data-mobile-static-backdrop
              className={cn(BADGE_CLASS, "bottom-2 right-2 tabular-nums")}
            >
              {formatVideoDuration(item.duration)}
            </span>
          </>
        }
      />
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-0.5",
          orientation === "row" ? "py-0.5 pr-0.5" : "px-2 pt-2 pb-2.5",
        )}
      >
        {/* 标题固定两行；第二行发布日期（竖线接 UP 主，投稿抽屉隐藏），第三行播放与弹幕。 */}
        <p className="line-clamp-2 min-h-[2lh] text-[13px] font-medium leading-snug text-foreground">
          {item.title}
        </p>
        <p className="flex min-h-4 min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/85">
          {item.pubdate > 0 && (
            <>
              {/* 日期不参与压缩：长 UP 主名会把可压缩的日期挤成「3 …」。 */}
              <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap">
                <CalendarDays className="size-3" aria-hidden />
                {formatRelativeTime(item.pubdate)}
              </span>
              {showAuthor && (
                <span aria-hidden className="shrink-0 text-border">
                  |
                </span>
              )}
            </>
          )}
          {showAuthor && <span className="min-w-0 truncate">{item.author}</span>}
        </p>
        <p className="flex min-h-4 items-center gap-1.5 text-[11px] text-muted-foreground/85">
          <span className="inline-flex items-center gap-0.5">
            <Play className="size-3" aria-hidden />
            {formatOnline(item.view)}
          </span>
          <span aria-hidden className="text-border">
            |
          </span>
          <span className="inline-flex items-center gap-0.5">
            {/*
              弹幕条数用**开启态**那个符号（`MessageSquareText`），与播放器三处弹幕
              开关（`danmakuControlPresentation`）的开启态同形 —— 卡片说的是"这条有多少
              弹幕"而不是"弹幕关着"，因此不用关闭态那个。这里曾经用不带字的方气泡，
              于是卡片上的弹幕与播放器里的弹幕看起来是两种东西。
            */}
            <MessageSquareText className="size-3" aria-hidden />
            {formatOnline(item.danmaku)}
          </span>
        </p>
      </div>
    </button>
  );
});

/**
 * 番剧 / 影视卡片。
 *
 * 点它直接进播放页：索引/排行榜接口都不给 bvid/cid（索引只给首集 ep_id，
 * 排行榜连它都不给），因此链接只带 season_id，播放页解析出要播的那一集
 * （有观看历史续播上次那一集，否则首集）后回写完整取流键；换集走右侧栏
 * 「分集」页签。
 */
export const PgcCard = memo(function PgcCard({ item }: { item: PgcItem }) {
  const navigate = useNavigate();
  const playPath = videoPlayPath({ seasonId: item.season_id, title: item.title });
  return (
    <button
      type="button"
      data-motion-press
      data-page-scroll-anchor={`pgc:${item.season_id}`}
      aria-label={`${item.title}${item.index_show ? `，${item.index_show}` : ""}`}
      onPointerEnter={() => preloadRouteModule(playPath)}
      onFocus={() => preloadRouteModule(playPath)}
      onClick={() => navigate(playPath)}
      className={CARD_CLASS}
    >
      <CoverImage
        cover={item.cover}
        overlay={
          item.badge ? (
            <span data-mobile-static-backdrop className={cn(BADGE_CLASS, "left-2 top-2")}>
              {item.badge}
            </span>
          ) : null
        }
      />
      <div className="flex flex-1 flex-col gap-0.5 px-2 pt-2 pb-2.5">
        <p className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
          {item.title}
        </p>
        <p className="min-h-4 truncate text-xs text-muted-foreground">{item.index_show ?? ""}</p>
      </div>
    </button>
  );
});

/** 视频卡片瀑布流。带 `playlist` 时点击卡片即从该卡连播。 */
export const VideoGrid = memo(function VideoGrid({
  items,
  playlist,
  playlistKind,
}: {
  items: readonly VideoItem[];
  playlist?: readonly PlaylistItem[];
  playlistKind?: PlaylistKind;
}) {
  return (
    <VideoMasonry>
      {items.map((item) => (
        <VideoCard
          key={`${item.bvid}:${item.cid ?? ""}`}
          item={item}
          playlist={playlist}
          playlistKind={playlistKind}
        />
      ))}
    </VideoMasonry>
  );
});
