import { memo } from "react";
import type { ComponentProps, RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, MessageSquareText, Play, UserRoundX } from "lucide-react";
import { preloadRouteModule } from "@/app/routeModules";
import { isMobileClient } from "@/shared/clientPlatform";
import { Spinner } from "@/components/ui/spinner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { notify } from "@/components/ui/toast";
import { useLongPressDrawer } from "@/shared/hooks/useLongPressDrawer";
import { useSettingsStore } from "@/shared/stores/settingsStore";
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
 *
 * 唯一的次级动作是「屏蔽 UP 主」：桌面端走右键菜单，触摸端走长按底部抽屉
 * （与直播卡同一套 `useLongPressDrawer` 接线）。屏蔽按 UID 精确匹配，因此条目
 * 没有 UID 时（老缓存、上游未下发）不提供这个入口 —— 点了没反应比没有入口更糟。
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
// 封面角标分两类，视觉上不能混：
//
// - `COVER_METRIC_CLASS`（播放/弹幕/时长）：事实数字，**无底色**，靠 `text-shadow-cover`
//   投影把白字从任意封面上拉出来（见 styles.css）。曾经用 `bg-black/65` 药丸：底排
//   三个角标各自一块黑块，读起来比封面本身还重，在深色封面上又几乎看不出边界。
// - `BADGE_CLASS`（推荐理由）：平台给的运营标签，需要读作「一块标签」而不是一个数字，
//   保留药丸底色与圆角。
const COVER_METRIC_CLASS =
  "inline-flex items-center gap-1.5 text-[11px] font-medium text-white tabular-nums text-shadow-cover";
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
  // 屏蔽 UP 主按 UID 精确匹配，条目缺失 UID 时这项操作无处可落（昵称不能当身份），
  // 因此不给这个入口 —— 点了没反应比没有入口更糟。
  const uploaderMid = item.author_mid?.trim() ?? "";
  const mobile = isMobileClient();
  const cardDrawer = useLongPressDrawer({ enabled: mobile && uploaderMid !== "" });

  function blockUploader() {
    // 与弹幕列表的「屏蔽」同一语义：立刻生效、写进设置里的名单，
    // 可在「设置 → 消息过滤」里改回来，因此不再叠一层确认。
    useSettingsStore.getState().blockVideoUploader(uploaderMid);
    notify.success(`已屏蔽 ${item.author || "该 UP 主"}`, "其视频不再出现在浏览列表与竖屏流中。");
  }

  function openVideo() {
    // 长按弹出操作抽屉后，松手合成的点按属于菜单手势的一部分，不打开视频。
    if (cardDrawer.consumeSyntheticClick()) return;
    if (!playPath) return;
    // 列表上下文保留点击时刻的快照；推荐流只供手动换片，不冒充下一集。
    if (playlist && playlist.some((entry) => entry.id === playListId)) {
      usePlaylistStore
        .getState()
        .setPlaylist([...playlist], playListId, playlistKind, playlistUploader);
    }
    onNavigate?.();
    navigate(playPath);
  }

  // 三个分支（无 UID / 触摸端 / 桌面端）共用同一套属性，避免三份漂移。
  // 与 `RoomCard` 的 `cardButtonProps` 同一写法。
  const cardButtonProps: ComponentProps<"button"> = {
    type: "button",
    onClick: openVideo,
    onPointerEnter: (event) => {
      if (playPath) preloadRouteModule(playPath);
      preview.onPointerEnter(event);
    },
    onPointerLeave: preview.stop,
    onFocus: () => {
      if (playPath) preloadRouteModule(playPath);
    },
    disabled: !playable,
    "aria-label": `${item.title}，UP 主 ${item.author}，时长 ${formatVideoDuration(item.duration)}`,
    className: cn(
      CARD_CLASS,
      // row 下缩略图与文本块垂直居中：侧栏里三行文本高于 16:9 封面，
      // 顶对齐会在封面下方留一段空白。缩略图因此不满幅，用内边距把它收进卡片。
      orientation === "row" && "flex-row items-center gap-2.5 p-1.5",
      !playable && "cursor-not-allowed opacity-60",
    ),
  };

  const cardBody = (
    <>
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
            {/* 推荐理由是平台给的运营文案（如「百万播放」），放左上与底排的统计、
                时长分开，三者都靠边而不互相挤。 */}
            {item.rcmd_reason && (
              <span
                data-mobile-static-backdrop
                className={cn(BADGE_CLASS, "left-2 top-2 max-w-[70%] truncate")}
              >
                {item.rcmd_reason}
              </span>
            )}
            {orientation === "grid" ? (
              // 播放/弹幕搬到封面左下、与右下时长同一排：卡片少一行文字，瀑布流更紧凑，
              // 统计也贴着封面读。行式卡的缩略图只有 2/5 列宽，放不下这一排，
              // 统计仍留在文本块第三行（见下方）。
              //
              // 播放与弹幕之间不用竖线：三个角标都无底色，竖线会成为这一排里最重的
              // 一道黑，反而把两个数字拆成两件事；用固定间距分组更轻、也更好读。
              //
              // 窄卡（xl 六列约 184px）遇上两个六位数统计会超宽：统计可收缩，
              // 两个数字各自 ellipsis，时长固定不缩 —— 宁肯截尾也不把时长挤出封面。
              <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
                <span className={cn(COVER_METRIC_CLASS, "min-w-0 gap-2")}>
                  <span className="inline-flex min-w-0 items-center gap-0.5">
                    <Play className="size-3 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{formatOnline(item.view)}</span>
                  </span>
                  <span className="inline-flex min-w-0 items-center gap-0.5">
                    <MessageSquareText className="size-3 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{formatOnline(item.danmaku)}</span>
                  </span>
                </span>
                <span className={cn(COVER_METRIC_CLASS, "shrink-0")}>
                  {formatVideoDuration(item.duration)}
                </span>
              </div>
            ) : (
              <span className={cn(COVER_METRIC_CLASS, "absolute bottom-2 right-2 shrink-0")}>
                {formatVideoDuration(item.duration)}
              </span>
            )}
          </>
        }
      />
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-0.5",
          orientation === "row" ? "py-0.5 pr-0.5" : "px-2 pt-2 pb-2.5",
        )}
      >
        {/* 标题固定两行；第二行发布日期（竖线接 UP 主，投稿抽屉隐藏）。播放与弹幕
            只在行式卡留在这里：网格卡已把它们搬到封面左下、与时长同一排。 */}
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
        {orientation === "row" && (
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
        )}
      </div>
    </>
  );

  if (uploaderMid === "") {
    // 没有 UID 的条目（老缓存 / 上游未下发）只有「打开」这一种动作，
    // 不挂右键菜单与长按抽屉，免得弹出只有一条无操作菜单的浮层。
    return (
      <button
        {...cardButtonProps}
        data-motion-press
        data-page-scroll-anchor={`video:${item.bvid}:${item.cid ?? ""}`}
        data-player-origin={`video:${item.bvid}:${item.cid ?? ""}`}
      >
        {cardBody}
      </button>
    );
  }

  if (mobile) {
    return (
      <>
        <button
          {...cardButtonProps}
          data-motion-press
          data-page-scroll-anchor={`video:${item.bvid}:${item.cid ?? ""}`}
          data-player-origin={`video:${item.bvid}:${item.cid ?? ""}`}
          onPointerDown={cardDrawer.onPointerDown}
          onPointerMove={cardDrawer.onPointerMove}
          onPointerUp={cardDrawer.onPointerUp}
          onPointerCancel={cardDrawer.onPointerCancel}
          onContextMenu={cardDrawer.onContextMenu}
        >
          {cardBody}
        </button>

        {/* 长按弹出的底部操作抽屉，画法对齐直播卡的同名抽屉。 */}
        <Drawer open={cardDrawer.open} onOpenChange={cardDrawer.setOpen}>
          <DrawerContent>
            <DrawerTitle className="truncate">{item.title}</DrawerTitle>
            <Button
              type="button"
              variant="ghost"
              className="mt-2 w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive max-md:h-10"
              onClick={() => {
                cardDrawer.setOpen(false);
                blockUploader();
              }}
            >
              <UserRoundX aria-hidden />
              屏蔽 {item.author || "此 UP 主"}
            </Button>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            {...cardButtonProps}
            data-motion-press
            data-page-scroll-anchor={`video:${item.bvid}:${item.cid ?? ""}`}
            data-player-origin={`video:${item.bvid}:${item.cid ?? ""}`}
          />
        }
      >
        {cardBody}
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-44">
        <ContextMenuGroup>
          <ContextMenuLabel>{item.title}</ContextMenuLabel>
          <ContextMenuItem onClick={blockUploader} className="text-destructive">
            <UserRoundX aria-hidden />
            屏蔽 UP 主 {item.author || ""}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
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
      data-player-origin={`pgc:${item.season_id}`}
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
