import { memo } from "react";
import type { ComponentProps } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, MessageSquareText, Play, UserRoundX } from "lucide-react";
import { preloadRouteModule } from "@/app/routeModules";
import { isMobileClient } from "@/shared/clientPlatform";
import { Spinner } from "@/components/ui/spinner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { notify } from "@/components/ui/toast";
import { useLongPressDrawer } from "@/shared/hooks/useLongPressDrawer";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { videoDimensionAspect } from "@/shared/videoDimension";
import { formatOnline, cn } from "@/lib/utils";
import { CARD_GRID_CLASS } from "@/shared/components/cardGrid";
import {
  MEDIA_CARD_BADGE_CLASS,
  MEDIA_CARD_CLASS,
  MediaCardCover,
  MediaCardMetrics,
  MediaCardText,
} from "@/shared/components/MediaCard";
import type { PgcItem, VideoItem } from "@/shared/types/video";
import { useVideoCardPreview } from "./videoCardPreview";
import { videoGetArchive } from "./videoApi";
import {
  upsertVideoDownloadInCache,
  videoDownloadStart,
  videoDownloadSupported,
} from "./videoDownload";
import { videoCardDownloadErrorText, videoCardDownloadInput } from "./videoCardDownload";
import {
  usePlaylistStore,
  type PlaylistItem,
  type PlaylistKind,
  type PlaylistUploader,
} from "./playlistStore";
import { formatRelativeTime, formatVideoDuration } from "./videoHistory";
import { videoFrameHintNavigationState, videoPlayPath } from "./videoRoute";

/**
 * 视频卡片。
 *
 * 与直播的 `RoomCard` 同一套画法（同样的圆角、封面比例、渐变与角标位置），但承载的
 * 事实不同：VOD 展示时长、播放量、弹幕数与 UP 主，直播展示热度与开播状态。因此是
 * 一个并列的组件而不是给 `RoomCard` 加分支 —— 那个组件还挂着关注、多画面、长按抽屉
 * 等一整套直播专属动作，VOD 一个都用不上。
 *
 * 次级动作是「下载」与「屏蔽 UP 主」：桌面端走右键菜单，触摸端走长按底部抽屉
 * （与直播卡同一套 `useLongPressDrawer` 接线）。屏蔽按 UID 精确匹配，因此条目
 * 没有 UID 时（老缓存、上游未下发）不提供这个入口 —— 点了没反应比没有入口更糟。
 */

export const VideoCard = memo(function VideoCard({
  item,
  playlist,
  playlistKind = "sequence",
  playlistUploader,
  onNavigate,
  orientation = "grid",
  showAuthor = true,
  showPubdate = true,
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
  /** 是否在发布日期旁显示 UP 主名；投稿抽屉按 PiliPlus 语义只显示发布日期。 */
  showAuthor?: boolean;
  /**
   * 是否显示发布日期。
   *
   * 只有 APP 推荐流关闭：该接口不下发日期，补齐它的接口又会被风控拒绝。热门、
   * 分区榜、Web 推荐、搜索、相关视频与 UP 投稿等自带日期的列表保持显示。
   */
  showPubdate?: boolean;
}) {
  const navigate = useNavigate();
  // 搜索与 UP 主空间列表的条目没有 cid：只要带 bvid 就可点，播放页用稿件详情
  // 补齐取流键（P1）。真正不可点的只剩无 bvid 的脏数据（后端已过滤，防御而已）。
  const playable = Boolean(item.bvid);
  const playPath = playable
    ? videoPlayPath({ bvid: item.bvid, cid: item.cid ?? null, title: item.title, aid: item.aid })
    : null;
  const frameAspectRatio = videoDimensionAspect(item.dimension);
  const frameHint =
    playPath && item.cid && item.cid > 0 && frameAspectRatio !== null
      ? videoFrameHintNavigationState({
          videoKey: `${item.bvid}:${item.cid}`,
          frameAspectRatio,
        })
      : undefined;
  const preview = useVideoCardPreview({ bvid: item.bvid, cid: item.cid });
  const playListId = `${item.bvid}_${item.cid ?? 0}`;
  // 屏蔽 UP 主按 UID 精确匹配，条目缺失 UID 时这项操作无处可落（昵称不能当身份），
  // 因此不给这个入口 —— 点了没反应比没有入口更糟。
  const uploaderMid = item.author_mid?.trim() ?? "";
  const mobile = isMobileClient();
  const canDownload = playable && videoDownloadSupported();
  const cardDrawer = useLongPressDrawer({
    enabled: mobile && (uploaderMid !== "" || canDownload),
  });
  const queryClient = useQueryClient();
  const downloadMutation = useMutation({
    mutationFn: async () => {
      if (!item.bvid) throw new Error("这条视频缺少 BV 号，无法下载。");
      preview.stop();

      // 已有 cid 时不必再取详情，也避免额外请求打断列表浏览。
      const archive =
        item.cid && item.cid > 0
          ? undefined
          : await queryClient.fetchQuery({
              queryKey: ["video_archive", item.bvid],
              queryFn: () => videoGetArchive(item.bvid),
              staleTime: 5 * 60_000,
              retry: false,
            });
      return videoDownloadStart(videoCardDownloadInput(item, archive));
    },
    onSuccess: (download) => {
      upsertVideoDownloadInCache(queryClient, download);
      if (download.status === "completed") {
        notify.success("该视频已下载", "可在关注页的「下载」页签中查看。");
      } else {
        notify.success("已加入下载队列", "可在关注页的「下载」页签中查看进度。");
      }
    },
    onError: (error) => notify.error("加入下载队列失败", videoCardDownloadErrorText(error)),
  });

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
    navigate(playPath, frameHint ? { state: frameHint } : undefined);
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
      MEDIA_CARD_CLASS,
      // row 下缩略图与文本块垂直居中：侧栏里三行文本高于 16:9 封面，
      // 顶对齐会在封面下方留一段空白。缩略图因此不满幅，用内边距把它收进卡片。
      orientation === "row" && "flex-row items-center gap-2.5 p-1.5",
      !playable && "cursor-not-allowed opacity-60",
    ),
  };

  const cardBody = (
    <>
      <MediaCardCover
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
                className={cn(MEDIA_CARD_BADGE_CLASS, "left-2 top-2 max-w-[70%] truncate")}
              >
                {item.rcmd_reason}
              </span>
            )}
            {orientation === "grid" ? (
              <MediaCardMetrics
                stats={
                  <>
                    <span className="inline-flex min-w-0 items-center gap-0.5">
                      <Play className="size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">{formatOnline(item.view)}</span>
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-0.5">
                      <MessageSquareText className="size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">{formatOnline(item.danmaku)}</span>
                    </span>
                  </>
                }
                duration={formatVideoDuration(item.duration)}
              />
            ) : (
              <MediaCardMetrics duration={formatVideoDuration(item.duration)} />
            )}
          </>
        }
      />
      <MediaCardText
        title={item.title}
        date={showPubdate && item.pubdate > 0 ? formatRelativeTime(item.pubdate) : null}
        author={showAuthor ? item.author : null}
        className={orientation === "row" ? "py-0.5 pr-0.5" : undefined}
      >
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
      </MediaCardText>
    </>
  );

  if (uploaderMid === "" && !canDownload) {
    // 没有 UID 且当前宿主不支持下载时只有「打开」这一种动作，
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
            {canDownload && (
              <Button
                type="button"
                variant="ghost"
                className="mt-2 w-full justify-start max-md:h-10"
                disabled={downloadMutation.isPending}
                onClick={() => {
                  cardDrawer.setOpen(false);
                  downloadMutation.mutate();
                }}
              >
                {downloadMutation.isPending ? (
                  <Spinner data-icon="inline-start" aria-hidden />
                ) : (
                  <Download data-icon="inline-start" aria-hidden />
                )}
                {downloadMutation.isPending ? "正在加入下载队列" : "下载"}
              </Button>
            )}
            {uploaderMid !== "" && (
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
            )}
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

      <ContextMenuContent className="w-60 max-w-[calc(100vw-1rem)]">
        <ContextMenuGroup>
          <ContextMenuLabel className="truncate" title={item.title}>
            {item.title}
          </ContextMenuLabel>
          {canDownload && (
            <ContextMenuItem
              disabled={downloadMutation.isPending}
              onClick={() => downloadMutation.mutate()}
            >
              {downloadMutation.isPending ? <Spinner aria-hidden /> : <Download aria-hidden />}
              {downloadMutation.isPending ? "正在加入下载队列" : "下载"}
            </ContextMenuItem>
          )}
        </ContextMenuGroup>
        {canDownload && uploaderMid !== "" && <ContextMenuSeparator />}
        {uploaderMid !== "" && (
          <ContextMenuGroup>
            <ContextMenuItem onClick={blockUploader} className="text-destructive">
              <UserRoundX aria-hidden />
              屏蔽 UP 主 {item.author || ""}
            </ContextMenuItem>
          </ContextMenuGroup>
        )}
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
      className={MEDIA_CARD_CLASS}
    >
      <MediaCardCover
        cover={item.cover}
        overlay={
          item.badge ? (
            <span
              data-mobile-static-backdrop
              className={cn(MEDIA_CARD_BADGE_CLASS, "left-2 top-2")}
            >
              {item.badge}
            </span>
          ) : null
        }
      />
      <MediaCardText title={item.title} author={item.index_show ?? null} />
    </button>
  );
});

/** 视频卡片网格，列数与间距对齐直播首页。带 `playlist` 时点击卡片即从该卡连播。 */
export const VideoGrid = memo(function VideoGrid({
  items,
  playlist,
  playlistKind,
  showPubdate = true,
}: {
  items: readonly VideoItem[];
  playlist?: readonly PlaylistItem[];
  playlistKind?: PlaylistKind;
  /** 见 `VideoCard` 的同名属性；APP 推荐流传 false。 */
  showPubdate?: boolean;
}) {
  return (
    <div className={CARD_GRID_CLASS}>
      {items.map((item) => (
        <VideoCard
          key={`${item.bvid}:${item.cid ?? ""}`}
          item={item}
          playlist={playlist}
          playlistKind={playlistKind}
          showPubdate={showPubdate}
        />
      ))}
    </div>
  );
});
