import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  FastForward,
  Film,
  Info,
  MessageCircle,
  MessageSquareOff,
  MessageSquareText,
  RefreshCw,
  ScrollText,
  UserRoundX,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { DanmakuComposer } from "@/features/room/BilibiliDanmakuComposer";
import { CommentsPanel } from "@/features/video/CommentsPanel";
import { videoGetArchive, videoGetPlayerMeta } from "@/features/video/videoApi";
import { formatRelativeTime, formatVideoDuration } from "@/features/video/videoHistory";
import { videoPlayPath } from "@/features/video/videoRoute";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/shared/components/ErrorState";
import { BilibiliAppAuthAction } from "@/shared/components/BilibiliAppAuthAction";
import { ShortsStageSkeleton } from "./ShortsStageSkeleton";
import { PlayerHudOverflowMenu, PlayerToolTile } from "@/shared/components/player/PlayerHudMenu";
import {
  danmakuControlPresentation,
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { panelDrawerSide, panelDrawerSizeClass } from "@/shared/components/player/panelDrawer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { useCoarsePointer } from "@/shared/hooks/useCoarsePointer";
import { ANDROID_BACK_EVENT, DISMISSIBLE_POPUP_SELECTOR, hasBrowserHistoryEntry } from "@/app/androidBackNavigation";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import { notify } from "@/components/ui/toast";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { ShortsChapterMenu } from "./ShortsChapterMenu";
import { ShortsSeekBar } from "./ShortsSeekBar";
import { ShortsSeekBridge, ShortsSeekPlayer } from "./shortsSeekPlayer";
import { ShortsBlankStage, ShortsStage } from "./ShortsStage";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_BOTTOM_CONTROLS_HEIGHT_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SEEK_BAR_HIT_OVERHANG_PX,
  SHORTS_SEED_PARAM,
  SHORTS_SLOT_IDS,
  SHORTS_TOP_BAR_HEIGHT_PX,
  SHORTS_TOP_CONTROLS_CLASS,
  shortsItemKey,
  shortsMountedIndexes,
  shortsSlotCoveredIndexes,
  shortsSlotTop,
  type ShortsSlotId,
} from "./shortsFeed";
import { useShortsStoryboard } from "./shortsStoryboard";
import { useShortsDanmaku } from "./useShortsDanmaku";
import { useShortsStableSlots } from "./useShortsStableSlots";
import { useShortsFeed } from "./useShortsFeed";
import { useShortsSessionRetention } from "./useShortsSessionRetention";
import { useShortsInteraction } from "./useShortsInteraction";

/**
 * `/shorts/bilibili`：B 站短视频（story feed）的竖屏消费页。
 *
 * 沉浸式路由（无侧栏、无顶栏，见 `immersiveRoutes`），返回口是顶部控制栏的
 * 悬浮箭头，与其他沉浸播放页同一位置同一画法。
 *
 * 上游是**无游标轮换流**：没有页码也没有总数，「加载更多」= 再拉一批并跨页去重，
 * 因此这一页永远不知道自己有多长。最后一条上的越界阻尼是「暂时到底」的反馈，
 * 不是终点声明；剩余不足 `SHORTS_PREFETCH_REMAINING` 条就提前补货。
 *
 * 播放与弹幕状态住在这一层而不是舞台里：顶部控制栏与底部操作栏必须固定在视口上
 * （随条带平移的话，换片时它们会跟着滑走），而它们要读 `muted`、播放状态
 * 与弹幕开关 —— 状态因此只能放在两者共同的祖先。舞台是纯展示层。
 *
 * ## 三播放器槽位
 *
 * 三个面板按槽位挂载（key 恒定 `slot-a` / `slot-b` / `slot-c`），换片只改变它们
 * 各自持有哪一条与谁在播。被提升为活动的那个槽位已经预热好，因此换片不重新取流、
 * 不重建播放器（见 `useShortsSlots`）。
 */
export function ShortsPage() {
  const navigate = useNavigate();
  /**
   * 入口种子：从播放页「短视频」进来时带 `?seed=<bvid>`，以那条为起点开流。
   * 只作首屏初值；条目到位后由下面的 effect 接手，改成「当前正在看的那条」。
   */
  const [searchParams] = useSearchParams();
  const entrySeed = searchParams.get(SHORTS_SEED_PARAM);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  /**
   * 三个槽位各自独占的媒体元素。
   *
   * 由页面持有、传给各自的舞台。它们是**槽位**的 ref 而不是「当前条目」的 ref：
   * 槽位面板的 key 恒定，因此这三个 `<video>` 跨换片存活，播放器得以复用
   * （见 `useShortsSlots`）。
   */
  const slotARef = useRef<HTMLVideoElement | null>(null);
  const slotBRef = useRef<HTMLVideoElement | null>(null);
  const slotCRef = useRef<HTMLVideoElement | null>(null);
  const slotRefs = useMemo(
    () => ({ a: slotARef, b: slotBRef, c: slotCRef }),
    [slotARef, slotBRef, slotCRef],
  );
  const [feedMotionActive, setFeedMotionActive] = useState(false);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [infoVisible, setInfoVisible] = useState(true);
  /** 进度条是否被交互过：悬停或按下一次后就去取快照。 */
  const [seekArmedKey, setSeekArmedKey] = useState<string | null>(null);
  /**
   * 页面层控件要对齐的宽度（px）。
   *
   * 平板（粗指针）上竖屏画面收成居中的竖卡，顶栏/信息/评论/换片箭头/进度条要跟着它
   * 收窄，否则控件贴屏幕边、画面在中间，读起来像两个不相干的层。0 表示铺满（手机
   * 竖屏），此时控件保持通栏。由活动舞台上报（见 `ShortsStage` 的 `onChromeColumn`）。
   *
   * 只在粗指针（平板/触摸）上启用：桌面（细指针鼠标）上竖屏也是居中的竖卡，但那里
   * 的既有设计是把信息与评论贴**屏幕**两角（避免又收成一条居中的定宽容器，见下方的
   * 说明与浏览器夹具），因此不动。这与 `styles.css` 的 `touch-wide` variant 同一判据。
   */
  const [stageChromeColumn, setStageChromeColumn] = useState(0);
  const coarsePointer = useCoarsePointer();
  const chromeColumn = coarsePointer ? stageChromeColumn : 0;
  const compact = useCompactPlayerViewport();

  const feed = useShortsFeed(entrySeed, feedMotionActive);
  const { items, index, setIndex, feedQuery } = feed;
  const current = items[index] ?? null;

  /**
   * 进度条的缩略图表。
   *
   * 查询放在页面层而不是进度条里：换片时要拿到**当前条**的快照，而进度条只负责画。
   * 武装状态绑定内容身份，换片不会为未交互的条目继续请求快照。
   */
  const seekItemKey = current ? shortsItemKey(current) : "";
  const { thumbnails } = useShortsStoryboard({
    bvid: current?.bvid ?? "",
    cid: current?.cid ?? 0,
    enabled: !!seekItemKey && seekArmedKey === seekItemKey,
  });
  const armSeek = useCallback(() => setSeekArmedKey(seekItemKey), [seekItemKey]);

  /* ---------- 播放、弹幕与抽屉 ---------- */

  const danmaku = useShortsDanmaku(current?.cid ?? 0, danmakuVisible);
  // 保留刚看过的那条的取流会话：一次跳变（进/退 UP 主模式、列表重排）会把新目标
  // 甩出槽位窗口，那一次实测要付 386~481ms 的取流。
  const retention = useShortsSessionRetention();
  const { slots, slotStates, playback } = useShortsStableSlots({
    items,
    index,
    refs: slotRefs,
    onProgress: danmaku.ensure,
    retention,
  });
  const panels = useShortsPanels(current);
  const controlsAvailable = playback.hasFrame || playback.ready || !!playback.error;

  /**
   * 章节：与播放页同一个 player v2 请求与缓存键（`video_player_meta`），从竖屏点进播放页
   * 不再重复请求。等当前条出画/可播后才发，不与首帧取流抢带宽；失败或没有章节就不显示入口。
   */
  const [chapterMenuOpen, setChapterMenuOpen] = useState(false);
  const chapterCid = current?.cid ?? 0;
  const chapterBvid = current?.bvid ?? "";
  const playerMetaQuery = useQuery({
    queryKey: ["video_player_meta", chapterCid, chapterBvid, ""],
    enabled: chapterCid > 0 && chapterBvid !== "" && (playback.hasFrame || playback.ready),
    queryFn: () => videoGetPlayerMeta({ bvid: chapterBvid, cid: chapterCid, ep_id: null }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const chapters = playerMetaQuery.data?.chapters;
  useEffect(() => {
    // 换片后上一条的章节弹层不能留着：它会一直挡住换片手势（见 `blocked`）。
    // oxlint-disable-next-line react/set-state-in-effect
    setChapterMenuOpen(false);
  }, [seekItemKey]);

  const {
    gestureActive,
    onSurfaceTap,
    goToIndex,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onWheel,
    resetInteraction,
  } = useShortsInteraction({
    items,
    index,
    setIndex,
    viewportRef,
    trackRef,
    playback,
    navigationLocked: feed.navigationLocked,
    // 章节弹层展开时列表要能上下滚，手指/滚轮不能同时被当成换片。
    blocked: panels.anyOpen || chapterMenuOpen,
    onMotionActiveChange: setFeedMotionActive,
    onBoundary: (next) => {
      if (feed.uploaderMode) void feed.load(next < 0 ? "prev" : "next");
    },
  });

  const goBack = useCallback(() => {
    if (feed.uploaderMode) {
      resetInteraction();
      feed.exitUploader();
      return;
    }
    if (hasBrowserHistoryEntry(window.history.state)) navigate(-1);
    else navigate("/shorts", { replace: true });
  }, [feed, navigate, resetInteraction]);

  // 作者模式是页内的一层：系统 Back / Escape 与顶栏返回采用相同优先级。
  // 评论和菜单先消费返回，不一次关闭两层。
  useEffect(() => {
    if (!feed.uploaderMode) return;
    const onBack = (event: Event) => {
      if (event.defaultPrevented || document.querySelector(DISMISSIBLE_POPUP_SELECTOR)) return;
      event.preventDefault();
      goBack();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack(event);
    };
    window.addEventListener(ANDROID_BACK_EVENT, onBack);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener(ANDROID_BACK_EVENT, onBack);
      window.removeEventListener("keydown", onEscape);
    };
  }, [feed.uploaderMode, goBack]);

  const openInPlayer = useCallback(() => {
    if (!current) return;
    navigate(
      videoPlayPath({
        bvid: current.bvid,
        cid: current.cid ?? 0,
        epId: null,
        title: current.title,
        aid: current.aid,
      }),
    );
  }, [current, navigate]);

  /**
   * 评论与详情的内容体经 memo 固定。
   *
   * 评论区可能包含上百条记录，避免舞台/手势状态变化带动整份评论树重渲染。
   * 详情抽屉也只跟条目身份有关，不该跟着舞台状态重建。
   */
  const commentsBody = useMemo(
    () =>
      panels.aid ? (
        // `bottomInset` 只影响二级回复抽屉自己的滚动容器：那一层是与评论抽屉并列的
        // 浮层（不是它的后代），因此拿不到这里外壳补的安全区，得自己让位。
        <CommentsPanel key={panels.aid} aid={panels.aid} bottomInset={SHORTS_SAFE_AREA_BOTTOM} />
      ) : null,
    [panels.aid],
  );
  const detailBody = useMemo(
    () =>
      current ? (
        <ShortsDetailBody key={current.bvid} item={current} open={panels.detailOpen} />
      ) : null,
    [current, panels.detailOpen],
  );

  /* ---------- 渲染 ---------- */

  if (feedQuery.isPending) {
    // 首屏加载：画面区留黑（视频本来就在那里），只把左下信息浮层与底部操作栏
    // 先画出来。返回口用与成品同一个 `ShortsBackButton`，加载完成时不会换一颗。
    return (
      <div className="relative h-full min-h-0">
        <ShortsBackButton onClick={goBack} />
        <ShortsStageSkeleton label="正在加载短视频…" />
      </div>
    );
  }

  if (feedQuery.isError && items.length === 0) {
    return (
      <div className="relative flex h-full min-h-0 flex-col items-center justify-center bg-black px-6">
        <ShortsBackButton onClick={goBack} showDouyinEntry />
        <ErrorState
          error={feedQuery.error}
          title="短视频加载失败"
          onRetry={() => void feedQuery.refetch()}
          action={<BilibiliAppAuthAction error={feedQuery.error} />}
          className="max-w-md"
        />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="relative flex h-full min-h-0 flex-col items-center justify-center bg-black">
        <ShortsBackButton onClick={goBack} showDouyinEntry />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquareOff aria-hidden />
            </EmptyMedia>
            <EmptyTitle>暂时没有短视频</EmptyTitle>
            <EmptyDescription>上游轮换流这一批没有可播条目，稍后再试。</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={() => void feedQuery.refetch()}>
            重新加载
          </Button>
        </Empty>
      </div>
    );
  }

  const mounted = shortsMountedIndexes(index, items.length);
  /** 挂载窗口里由槽位面板承担的下标；其余渲染空舞台占位。 */
  const slotCovered = shortsSlotCoveredIndexes(slots);
  const slotIds: ShortsSlotId[] = [...SHORTS_SLOT_IDS];

  // 弹幕开关的图标与标签：与直播间、播放页共用同一个判据，避免三处各写一对
  // 图标后开启态长得不一样（这里曾经用裸 `MessageSquare`，另两处是
  // `MessageSquareText`）。
  const danmakuControl = danmakuControlPresentation(danmakuVisible);

  return (
    <ShortsSeekPlayer>
      <div
        ref={viewportRef}
        data-slot="shorts-viewport"
        data-feed-mode={feed.uploaderMode ? "uploader" : "recommendation"}
        data-current-aid={current?.aid}
        // `media-skin` 提供 `--media-*` 令牌（白字 + 白色半透明悬停底）。复用播放器
        // HUD 的溢出菜单需要它：那些控件的配色走令牌，不在这个作用域里会落到应用
        // 前景色 —— 在黑舞台上变成看不见的深色图标。
        className="media-skin relative h-full min-h-0 overflow-hidden bg-black"
        style={
          {
            // 纵向手势由本页接管，横向留给系统返回手势。
            touchAction: "pan-x",
            // 进度条与悬停预览保持现有缩放；顶栏按钮另有自己的尺寸作用域。
            "--media-scale-unit": "1.2rem",
          } as React.CSSProperties
        }
        onPointerDownCapture={onPointerDownCapture}
        onPointerMoveCapture={onPointerMoveCapture}
        onPointerUpCapture={onPointerUpCapture}
        onPointerCancelCapture={onPointerCancelCapture}
        onWheel={onWheel}
      >
        <div ref={trackRef} data-slot="shorts-track" className="relative h-full">
          {/*
            槽位面板：key 恒定（`slot-a` / `slot-b` / `slot-c`），换片只改变
            `top` 与角色。

            这是播放器复用的前提 —— key 变化会卸载重建面板与 `<video>`，那样预
            热省下的取流时间会重新花在 DOM 与引擎的重建上。`style` 变化不触发
            remount，因此同一份 `<video>` 与 Video.js 实例跨换片存活。

            三个槽位都渲染 `ShortsStage`：两个预热槽位分别在前后邻居上缓冲到
            `canplay`，换片与回滑时它们才可能立刻出画。
          */}
          {slotIds.map((slotId) => {
            const held = slots.held[slotId];
            const item = held == null ? null : items[held];
            if (!item) return null;
            const active = slotId === slots.active;
            return (
              <div
                key={`slot-${slotId}`}
                data-slot="shorts-panel"
                data-slot-id={slotId}
                aria-hidden={active ? undefined : true}
                inert={active ? undefined : true}
                className="absolute inset-x-0 h-full"
                // 条目按绝对下标定位，换片不移动其中任何一个：收尾只动 track。
                style={{ top: shortsSlotTop(held) }}
              >
                <ShortsStage
                  item={item}
                  playback={slotStates[slotId]}
                  videoRef={slotRefs[slotId]}
                  mode={active ? "play" : "warm"}
                  danmaku={danmaku}
                  danmakuVisible={danmakuVisible}
                  gestureActive={gestureActive}
                  onSurfaceTap={onSurfaceTap}
                  onChromeColumn={setStageChromeColumn}
                />
              </div>
            );
          })}

          {/*
            挂载窗口里剩下的位置（第三条邻居）渲染空舞台占位：它们只需要有一块
            参与平移的黑底，不需要能播 —— 一条短视频等于一次签名 playurl + 两条
            sidx + 三个本机代理会话，为跟手再多起一份是把上游取流成本翻倍。
            占位刻意不画封面：加载期间统一是黑屏加转圈（见 `ShortsStage`）。
          */}
          {mounted.map((itemIndex) => {
            if (slotCovered.has(itemIndex)) return null;
            const item = items[itemIndex];
            if (!item) return null;
            return (
              <div
                key={shortsItemKey(item)}
                data-slot="shorts-panel"
                aria-hidden
                inert
                className="absolute inset-x-0 h-full"
                style={{ top: `${itemIndex * 100}%` }}
              >
                <ShortsBlankStage item={item} />
              </div>
            );
          })}
        </div>

        {/*
          把活动槽位的 `<video>` 桥接进进度条的播放器 store。

          必须渲染在槽位面板**之外**：面板里还有一层 `ShortsStagePlayer`（状态指示用的
          store），渲染在它里面会被那个更近的 Player 上下文截走。也不属于条带，
          否则换片时会跟着平移一起被变换。
        */}
        <ShortsSeekBridge videoRef={slotRefs[slots.active]} active={slots.active} />

        {/*
          页面层控件列：顶栏、信息与评论、换片箭头都收进这一层。

          宽屏（平板横屏、桌面）上竖屏画面会收成居中的竖卡，控件若还贴**屏幕**的边，
          就与画面隔着一大片黑，读起来像两个不相干的层。这里按舞台上报的
          `chromeColumn` 把本层收窄到画面宽度并居中（0 表示铺满，退回通栏 —— 手机
          竖屏与横屏源都是这一档，观感与从前一致）。

          本层不接指针（`pointer-events-none`）：它盖在画面上，接了就会把点按暂停
          那一整块挖掉。真正需要交互的子层（顶栏、换片箭头、信息浮层里的按钮）各自
          开 `pointer-events-auto`。
        */}
        <div
          data-slot="shorts-chrome-column"
          className={cn(
            "pointer-events-none absolute inset-y-0 z-20",
            chromeColumn === 0 && "inset-x-0",
          )}
          style={
            chromeColumn > 0
              ? { left: `calc(50% - ${chromeColumn / 2}px)`, width: `${chromeColumn}px` }
              : undefined
          }
        >
        {/* 顶部控制栏：返回 + 更多操作。固定在视口上，不随条带平移。

            紧贴视口顶边，也就是系统状态栏的下沿：状态栏的让位由 `.app-shell` 的
            `padding-top` 统一做（见 `styles.css`），这里再补一份顶部安全区会把返回/更多
            推到状态栏下方又一条的位置，中间空出一条谁都不用的黑带。

            收进控件列后，返回/更多就落在画面框的左右两条竖线上，与信息浮层的头像、
            评论按钮对齐。 */}
        {!controlsAvailable && (
          <div className="pointer-events-auto">
            <ShortsBackButton onClick={goBack} label={feed.uploaderMode ? "返回推荐流" : "返回上一页"} />
          </div>
        )}
        {controlsAvailable && <div
          data-slot="shorts-top-bar"
          className={cn(
            SHORTS_TOP_CONTROLS_CLASS,
            "pointer-events-auto absolute inset-x-0 top-0 z-20 flex items-center gap-1.5 px-2",
          )}
          style={{ height: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
        >
          <ShortsBackButton onClick={goBack} inline label={feed.uploaderMode ? "返回推荐流" : "返回上一页"} />
          {feed.uploaderMode && (
            <span
              data-slot="shorts-uploader-position"
              role="status"
              aria-label={feed.counter ? `UP 主列表，第 ${feed.counter.replace("/", " 条，共 ")} 条` : "UP 主列表"}
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm font-medium text-white tabular-nums"
            >
              {feed.counter ?? (feed.uploaderQuery.isError ? "UP 主列表" : "加载中…")}
            </span>
          )}
          <span className="ml-auto">
            <ShortsMoreMenu
              compact={compact}
              muted={playback.muted}
              onToggleMuted={playback.toggleMuted}
              onRefresh={playback.retry}
            />
          </span>
        </div>}

        {feed.uploaderMode && (
          <div
            data-slot="shorts-uploader-status"
            className="pointer-events-auto absolute inset-x-12 z-20 flex flex-col items-center gap-1 text-center text-xs text-white"
            style={{ top: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
          >
            {!feed.uploaderReady && feed.uploaderQuery.isError && (
              <ErrorState
                error={feed.uploaderQuery.error}
                title="UP 主列表加载失败"
                onRetry={() => {
                  if (!feed.uploaderQuery.isFetching) void feed.uploaderQuery.refetch({ cancelRefetch: false });
                }}
                className="bg-black/90 px-3 py-2"
              />
            )}
            {(["prev", "next"] as const).map((direction) => {
              const error = feed.directionFailures?.[direction];
              if (!error) return null;
              return (
                <ErrorState
                  key={direction}
                  error={error}
                  title={`${direction === "prev" ? "前面" : "后面"}的条目加载失败`}
                  onRetry={() => void feed.load(direction, true)}
                  className="bg-black/90 px-3 py-2"
                />
              );
            })}
            {(feed.uploaderQuery.isFetchingPreviousPage || feed.uploaderQuery.isFetchingNextPage) && (
              <span role="status" className="rounded-md bg-black/75 px-3 py-1">正在加载{feed.uploaderQuery.isFetchingPreviousPage ? "前面" : "后面"}的条目…</span>
            )}
          </div>
        )}

        {/*
          长按倍速提示。挂在顶栏之下、视口固定层里：它描述的是「当前这一条正在被
          按住快放」，随条带平移会在换片时跟着画面滑走。

          读 `playback.rate` 而不是另存一个「倍速中」布尔：倍速的真相在媒体元素上，
          两处各存一份就会出现「提示还在、倍速已经回落」。
        */}
        {playback.rate > 1 && (
          <div
            data-slot="shorts-speed-hint"
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-sm font-medium text-white backdrop-blur-sm"
            style={{ top: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
          >
            <FastForward className="size-3.5" aria-hidden />
            {playback.rate.toFixed(1)}x 倍速中
          </div>
        )}

        {/* 桌面换片按钮：没有触摸时上下滑动无从进行，滚轮之外给一对显式入口。

            贴着控件列的外侧：宽屏上画面居中、两侧本来就有黑边，箭头放那儿不会盖住
            画面；铺满时（`chromeColumn === 0`）退回原来的贴屏幕右边。 */}
        <div
          className={cn(
            "pointer-events-auto absolute bottom-1/2 z-20 hidden translate-y-1/2 flex-col gap-2 md:flex",
            chromeColumn > 0 ? "left-full ml-3" : "right-3",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="上一条"
            title="上一条（↑）"
            disabled={feed.navigationLocked || (index === 0 && !feed.hasPreviousPage)}
            className="size-10 rounded-full bg-black/40 text-white/90 hover:bg-white/20 hover:text-white disabled:opacity-30"
            onClick={() => goToIndex(index - 1)}
          >
            <ChevronUp aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="下一条"
            title="下一条（↓）"
            disabled={feed.navigationLocked || (index >= items.length - 1 && !feed.hasNextPage)}
            className="size-10 rounded-full bg-black/40 text-white/90 hover:bg-white/20 hover:text-white disabled:opacity-30"
            onClick={() => goToIndex(index + 1)}
          >
            <ChevronDown aria-hidden />
          </Button>
        </div>

        {/*
          信息与评论：浮在画面上、紧贴进度条上方，属于**页面层**而不是舞台层。

          这是与上一版的关键区别：它们以前长在画面框里（会随换片的条带平移一起滑走），
          而且每个面板各有一份（相邻面板也得自带一份）。挂在页面层之后只有一份，位置固定
          在视口上，与两条控制栏、进度条共用同一套坐标。

          左下角是信息、右下角是评论 —— 两者贴播放器的左右两边，不再收在一个居中的定宽
          容器里。定宽居中是为了跟底栏那条输入行对齐，但代价是桌面上信息浮在画面中间偏左
          的位置：它描述的是**这一条视频**，该贴着画面的角，而不是跟一条输入框对齐。

          浮层而不占真实空间：它压在画面底部（裁切铺满后那是真画面像素），因此要自带渐变
          垫底 —— 不然亮底画面上的白字不可读。容器不接指针（只标题与评论按钮接），否则会
          在画面底部挖出一块点不动的区域（那里应该能点按暂停）。

          整块跟着「信息开关」一起显隐（评论按钮也在内）：那个开关的语义是「把画面让出来」，
          留一个按钮在角上就没让干净。渐变垫底也一起消失 —— 它只为白字可读性存在。
        */}
        {infoVisible && current && (
          <div
            data-slot="shorts-info-float"
            // `px-2` 与顶栏一致：左边的头像与返回按钮、右边的评论与 `⋮` 各自成一条竖线。
            className="pointer-events-none absolute inset-x-0 z-20 flex items-end justify-between gap-3 bg-gradient-to-t from-black/70 to-transparent px-2 pt-8"
            style={{
              bottom: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
              // 底部内边距让开进度条的命中区：那块区域只占 3px 布局、却向上盖住 17px，
              // 不让位的话点在评论数字上会变成一次 seek（实测会把进度拖到 0）。
              paddingBottom: `${SHORTS_SEEK_BAR_HIT_OVERHANG_PX}px`,
            }}
          >
            {/*
              信息块贴左下角，但宽度封顶：桌面上视口有 1400px 宽，不封顶的话标题会拉成
              一行到屏幕另一头（`max-w-md` ≈ 原来那个定宽容器减去评论按钮之后的可用宽度，
              因此手机与桌面的折行位置都不变）。
            */}
            <div className="flex min-w-0 max-w-md flex-1 flex-col gap-2">
              {/*
                UP 主块：头像跨「名字」与「粉丝数」两行。

                头像从右侧操作栏搬到这里。评论按钮离开右侧栏之后那根栏只剩一个不可点的
                头像 —— 一根只有装饰的操作栏不如不要。放在名字左边也更符合它本来的语义：
                这是这条的作者。
              */}
              <Button
                type="button"
                variant="ghost"
                data-slot="shorts-uploader-entry"
                aria-label={`查看 ${current.author || "该 UP 主"} 的竖屏流`}
                title={current.author_mid?.trim() ? "从当前稿件浏览此 UP 主的竖屏流" : "UP 主标识缺失，暂不可查看列表"}
                disabled={!current.author_mid?.trim() || feed.navigationLocked}
                className="pointer-events-auto h-auto max-w-full justify-start gap-2 self-start rounded-md px-0 py-1 text-left text-white hover:bg-white/15 hover:text-white"
                onClick={feed.enterUploader}
              >
                <Avatar className="size-8 shrink-0 after:border-white/40">
                  <AvatarImage
                    src={normalizeImageUrl(current.author_face)}
                    alt=""
                    aria-hidden
                    referrerPolicy="no-referrer"
                  />
                  <AvatarFallback className="bg-black/40 text-xs text-white/90">
                    {current.author?.slice(0, 1) || "U"}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-white">
                    @{current.author || "未知 UP 主"}
                  </span>
                  {/*
                    粉丝数只有 story 流白带（`owner.fans`），其余列表接口不给。
                    `null` 是「上游没说」而不是「0 个粉丝」，因此不渲染这一行。
                  */}
                  {current.author_fans != null && (
                    <span className="block truncate text-xs text-white/70">
                      {formatOnline(current.author_fans)} 粉丝
                    </span>
                  )}
                </span>
              </Button>
              {!current.author_mid?.trim() && <p className="text-xs text-white/70">UP 主标识缺失，暂不可查看列表</p>}

              {/*
                标题块：点标题开详情抽屉。

                详情入口从底栏搬到标题上（底栏那个改为去播放页），因此这里必须
                `pointer-events-auto`：整个浮层是不接指针的，否则会在画面底部挖出一块
                点不动的区域。箭头朝下是因为抽屉从下方推入。
              */}
              <div className="flex min-w-0 flex-col gap-0.5">
                {/*
                  展开箭头跟在标题文字末尾而不是右边界：内层 `w-fit` 让盒子收到内容宽，
                  短标题的箭头因此紧跟文字（而不是隔着一大片空白飘在右侧）；长标题被
                  `max-w-full` 撑满后剪到两行，箭头落在第二行末尾，仍然是「跟着文字」。

                  外层按钮仍然 `w-full`：触发区是整个标题区，只能点在字上的话命中太小。
                */}
                <button
                  type="button"
                  aria-label={`视频详情：${current.title}`}
                  title="视频详情"
                  className="pointer-events-auto block w-full text-left"
                  onClick={panels.openDetail}
                >
                  <span className="flex w-fit max-w-full items-end gap-1.5">
                    <span className="line-clamp-2 min-w-0 text-sm text-white/90">
                      {current.title}
                    </span>
                    {/* `mb-0.5` 把 16px 的箭头对到 20px 行高的文字中线上。 */}
                    <ChevronDown className="mb-0.5 size-4 shrink-0 text-white/70" aria-hidden />
                  </span>
                </button>
                <p className="text-xs text-white/70">
                  {formatOnline(current.view)} 次播放
                  {playback.duration > 0 || current.duration > 0
                    ? ` · ${formatVideoDuration(playback.duration || current.duration)}`
                    : ""}
                </p>
              </div>
              {/* 章节：与播放页竖屏一致，贴在进度条上方左侧；没有章节时不占位。
                  浮层整体不接指针，这一格要单独接回来。 */}
              <div data-slot="shorts-chapters" className="pointer-events-auto flex min-w-0 empty:hidden">
                <ShortsChapterMenu
                  chapters={chapters}
                  open={chapterMenuOpen}
                  onOpenChange={setChapterMenuOpen}
                  container={viewportRef}
                />
              </div>
            </div>

            {/*
              评论贴右下角。跟信息一起显隐（外层已经判了 `infoVisible`）。

              数字取 `reply`（评论数），不是 `danmaku`（弹幕数）：这个按钮开的是评论区，
              底下那行数字必须是评论数。此前误用了 `danmaku`，于是「评论 5」实际是
              「弹幕 5 条」—— 与评论区里真实条数（同一稿件 56 条）对不上。
              弹幕数在底部操作栏与信息行里各自有位置，不需要在这里重复一遍。
            */}
            <span className="pointer-events-auto flex shrink-0 flex-col items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={
                  current.reply != null && current.reply > 0
                    ? `评论，${formatOnline(current.reply)} 条`
                    : "评论"
                }
                title="评论"
                className="size-11 rounded-full text-white/90 hover:bg-white/15 hover:text-white"
                onClick={panels.openComments}
              >
                <MessageCircle className="size-6" aria-hidden />
              </Button>
              {current.reply != null && current.reply > 0 && (
                <span className="text-[11px] text-white/80">{formatOnline(current.reply)}</span>
              )}
            </span>
          </div>
        )}
        </div>

        {/*
          底部操作栏：进度条（上沿）+ 弹幕输入与三个开关（控制行）。

          占真实空间而不是浮在画面上（画面区域已经减掉了这条的高度，见
          `SHORTS_MEDIA_AREA_STYLE`）：输入框浮在画面底部会盖住字幕与信息，
          而软键盘弹起时浮层还会被顶到画面中间。

          进度条是这条栏的**上边缘**，替掉了原来那条 `border-t`：两者占的是同一条
          像素，同时存在只会让进度条看起来带了一圈描边。不被 `max-w-lg` 收窄 ——
          它描述的是时间而不是内容，通栏才读得出比例。
        */}
        {controlsAvailable && <div
          data-slot="shorts-bottom-bar"
          className="absolute inset-x-0 bottom-0 z-20 flex flex-col bg-black/85"
          style={{
            height: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
            paddingBottom: SHORTS_SAFE_AREA_BOTTOM,
          }}
        >
          {/* 进度条也跟着控件列收窄；铺满时 `w-full` 铺满，与从前一致。

              包一层相对定位：进度条的命中层是 `absolute inset-x-0`，需要以这一层为
              定位基准，否则会去对齐整条底栏、又与画面错位。`mx-auto` 只在设了定宽时
              用 —— 它对一个 flex 交叉轴项会把宽度收成内容宽（进度条内容都是绝对定位，
              因此是 0），手机竖屏上会把进度条压成一条 0 宽的线。 */}
          <div
            className={cn("relative", chromeColumn > 0 ? "mx-auto" : "w-full")}
            style={chromeColumn > 0 ? { width: `${chromeColumn}px` } : undefined}
          >
            <ShortsSeekBar thumbnails={thumbnails} onArmed={armSeek} />
          </div>
          {/*
            控件收在一个居中的定宽容器里，而不是铺满栏宽。

            背景条必须通栏（它是画面区的下边界），但内容不该跟着摊开：桌面上把输入框
            拉到 1440px 宽、按钮甩到最右角，与居中的竖屏画面完全脱节。手机上
            `max-w` 不起作用，仍是通栏。
          */}
          <div
            className="flex flex-1 items-center px-2"
            style={{ height: `${SHORTS_BOTTOM_CONTROLS_HEIGHT_PX}px` }}
          >
            <div
              className={cn(
                "mx-auto flex w-full items-center gap-1.5",
                // 宽屏上控件列宽就是画面宽，不再另设 `max-w-lg` —— 两者同时存在时较小的那个
                // 生效，会在画面比 512px 略宽时对不齐（实测差 2px）。
                chromeColumn === 0 && "max-w-lg",
              )}
              style={chromeColumn > 0 ? { width: `${chromeColumn}px` } : undefined}
            >
              <div className="min-w-0 flex-1">
                {current && (
                  <DanmakuComposer
                    overlay
                    roomTitle={current.title}
                    video={{
                      cid: current.cid ?? 0,
                      aid: current.aid,
                      progressMs: Math.floor(playback.getCurrentTime() * 1000),
                    }}
                  />
                )}
              </div>
              {/*
                弹幕开关。

                图标与标签取自与直播间、播放页**同一个** `danmakuControlPresentation`：
                三处各自写死一对图标的结果是开启态长得不一样（这里曾经用裸
                `MessageSquare`，另两处是 `MessageSquareText`）。

                图标显式 `size-5`（基础组件的默认是 `size-4`）：这一行的按钮压在黑底上，
                16px 的线图标在竖屏画面下方偏小 —— 20px 在 40px 的按钮里留 10px 的呼吸，
                与浮层里那个 24px 的评论图标也不再差一档。
              */}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={danmakuControl.label}
                title={danmakuControl.label}
                aria-pressed={danmakuVisible}
                className="size-10 shrink-0 rounded-full text-white/90 hover:bg-white/15 hover:text-white"
                onClick={() => setDanmakuVisible((value) => !value)}
              >
                {danmakuControl.icon === "message-square-text" ? (
                  <MessageSquareText className="size-5" aria-hidden />
                ) : (
                  <MessageSquareOff className="size-5" aria-hidden />
                )}
              </Button>
              {/*
                信息开关同时收起画面底部那一整块浮层 —— 信息与评论按钮一起显隐。

                评论按钮曾经留在原地（当时的理由是「它不是信息，是入口」），但那样一来
                「隐藏信息」并不能真的把画面下沿让干净：一个按钮加一行弹幕数仍然压在那儿。
                想看清画面的人要的是**整块**让位，因此文案也一并说明范围。
              */}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={infoVisible ? "隐藏视频信息与评论按钮" : "显示视频信息与评论按钮"}
                title={infoVisible ? "隐藏视频信息与评论按钮" : "显示视频信息与评论按钮"}
                aria-pressed={infoVisible}
                className="size-10 shrink-0 rounded-full text-white/90 hover:bg-white/15 hover:text-white"
                onClick={() => setInfoVisible((value) => !value)}
              >
                <Info className="size-5" aria-hidden />
              </Button>
              {/*
                详情入口：直接去播放页。

                点它不再开抽屉 —— 抽屉改由信息行里的标题打开（那里是「看简介」的自然
                位置）。保留原文案与 `ScrollText` 图标，但 tooltip 说明目的地：这里没有
                独立的详情页，完整详情栏在播放页上。
              */}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="视频详情"
                title="视频详情（在播放页打开）"
                disabled={!current}
                className="size-10 shrink-0 rounded-full text-white/90 hover:bg-white/15 hover:text-white"
                onClick={openInPlayer}
              >
                <ScrollText className="size-5" aria-hidden />
              </Button>
            </div>
          </div>
        </div>}
      </div>

      {/*
        抽屉在视口**之外**。

        React 的合成事件按组件树冒泡，与 portal 把 DOM 挂到哪儿无关：放在视口
        div 里面时，抽屉内的滚动与拖动会先经过视口的 pointer 捕获处理器，被当成
        换片手势吃掉。移出来之后抽屉不再是视口的 React 后代，事件不再经过它。
      */}
      <Drawer open={panels.commentsOpen} onOpenChange={panels.setCommentsOpen}>
        <ShortsDrawerContent compact={compact} title="评论">
          {commentsBody}
        </ShortsDrawerContent>
      </Drawer>
      <Drawer open={panels.detailOpen} onOpenChange={panels.setDetailOpen}>
        <ShortsDrawerContent compact={compact} title="视频详情">
          {detailBody}
        </ShortsDrawerContent>
      </Drawer>
    </ShortsSeekPlayer>
  );
}

/**
 * 抽屉外壳。
 *
 * 侧别与尺寸走共享的 `panelDrawer` 几何：评论抽屉里点某条评论还会**再叠一层**
 * 二级回复抽屉（`CommentsPanel` 自带），两层的侧别与宽度必须完全一致，否则桌面上
 * 会露出下面那层的边。两处各写一份的结果就是不一致 —— 这里曾经是 22rem 而二级
 * 走基础组件的 20rem，右侧露出一条 32px 的缝。
 */
function ShortsDrawerContent({
  compact,
  title,
  children,
}: {
  compact: boolean;
  title: string;
  children: React.ReactNode;
}) {
  const side = panelDrawerSide(compact);
  return (
    <DrawerContent
      side={side}
      className={cn("flex flex-col overflow-hidden p-0", panelDrawerSizeClass(side))}
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <DrawerTitle>{title}</DrawerTitle>
      </div>
      {/*
        内容体不自带滚动容器，由这里提供。

        底部安全区的内边距加在滚动容器**内侧**：外壳用 `p-0` 抹掉了基础组件自带的
        `pb-[calc(1rem+env(safe-area-inset-bottom))]`（表头要贴边，不能有外层内边距），
        不补回来的话手机上最后一条评论会压在系统手势条下面。加在滚动容器上而不是
        外壳上，滚到底时才让出这段距离。
      */}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        style={{ paddingBottom: compact ? SHORTS_SAFE_AREA_BOTTOM : undefined }}
      >
        {children}
      </div>
    </DrawerContent>
  );
}

/**
 * 详情抽屉正文：稿件简介、标签与 UP 主统计。
 *
 * `video_get_archive` 只在抽屉真的打开后才发（`enabled: open`）：绝大多数条目
 * 不会被点开详情，换片时预取等于给每一条都白付一次稿件请求。
 */
function ShortsDetailBody({ item, open }: { item: VideoItemForDetail; open: boolean }) {
  const uploaderMid = item.author_mid?.trim() ?? "";
  function blockUploader() {
    useSettingsStore.getState().blockVideoUploader(uploaderMid);
    notify.success(`已屏蔽 ${item.author || "该 UP 主"}`, "其视频不再出现在浏览列表与竖屏流中。");
  }
  const archiveQuery = useQuery({
    queryKey: ["shorts_archive", item.bvid],
    enabled: open && item.bvid !== "",
    queryFn: () => videoGetArchive(item.bvid),
  });
  const archive = archiveQuery.data;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm leading-relaxed font-medium">{item.title}</h3>
        <p className="text-xs text-muted-foreground">
          {formatOnline(item.view)} 次播放 · {formatOnline(item.danmaku)} 条弹幕
          {item.pubdate > 0 ? ` · ${formatRelativeTime(item.pubdate)}` : ""}
        </p>
      </div>

      <div className="flex items-center gap-2">
        {/*
          头像必须走 `normalizeImageUrl`：它把地址改写到本机图片代理，而 B 站头像 CDN
          对带非 bilibili Referer 的请求回 403 —— WebView 无法为 `<img>` 去掉 Referer，
          直连一定是破图。`AvatarFallback` 再兜一层，代理未就绪时显示首字而不是破图标。
        */}
        <Avatar className="size-9 shrink-0">
          <AvatarImage
            src={normalizeImageUrl(item.author_face)}
            alt=""
            aria-hidden
            referrerPolicy="no-referrer"
          />
          <AvatarFallback>{item.author?.slice(0, 1) || "U"}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm">{item.author || "未知 UP 主"}</p>
          {archive && (archive.author_fans > 0 || archive.author_videos > 0) && (
            <p className="text-xs text-muted-foreground">
              {formatOnline(archive.author_fans)} 粉丝 · {formatOnline(archive.author_videos)} 投稿
            </p>
          )}
        </div>
        {/* 竖屏没有右键与长按抽屉（那两处都在浏览卡片上），屏蔽入口放在详情抽屉里。
            与卡片同一口径：按 UID 匹配，条目没有 UID 时不显示这个按钮。 */}
        {uploaderMid !== "" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => blockUploader()}
          >
            <UserRoundX data-icon="inline-start" aria-hidden />
            屏蔽
          </Button>
        )}
      </div>

      {archiveQuery.isPending && open && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-8/12" />
        </div>
      )}
      {archive?.desc ? (
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {archive.desc}
        </p>
      ) : null}
      {archive && archive.tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {archive.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 详情正文只用到这几个字段，收窄类型让它与 story 条目解耦。 */
type VideoItemForDetail = {
  bvid: string;
  title: string;
  author: string;
  /** 屏蔽 UP 主按它匹配；缺失时详情抽屉不显示屏蔽入口。 */
  author_mid?: string | null;
  author_face: string | null;
  view: number;
  danmaku: number;
  pubdate: number;
};

/**
 * 顶部「更多操作」菜单：静音、刷新。
 *
 * 「在播放页打开」曾经也在这里，现在只剩底栏那一个入口（`ScrollText` 图标那个按钮
 * 直接导航）。两个入口指向同一目的地时，菜单项多一层点击却没有额外语义。
 *
 * 静音是一次性设定（不是每条都要调），刷新只在取流失败时才有意义 —— 竖屏画面上的
 * 每个常驻按钮都在挡内容，能收进菜单的就收。
 *
 * 外壳复用 `PlayerHudOverflowMenu` —— 直播间 HUD 与视频播放页用的是同一个组件，
 * 短视频这里再自写一套的结果就是三个表面上的「更多操作」各长一个样（触发图标、
 * 浮层材质、菜单项排布全都不同）。复用同时白拿两件事：紧凑视口自动换成抽屉，
 * 以及 `⋮` 触发按钮的尺寸与配色走 `--media-*` 令牌（视口上的 `media-skin` 提供）。
 */
function ShortsMoreMenu({
  compact,
  muted,
  onToggleMuted,
  onRefresh,
}: {
  compact: boolean;
  muted: boolean;
  onToggleMuted: () => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const runAndClose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <PlayerHudOverflowMenu
      label="更多操作"
      title="短视频操作"
      open={open}
      onOpenChange={setOpen}
      compact={compact}
    >
      {/* 两列：跳播放页的入口已经搬到底栏（那个按钮直接导航），菜单里不再重复。 */}
      <div className="grid grid-cols-2 gap-1.5 max-md:gap-2">
        <PlayerToolTile
          icon={muted ? VolumeX : Volume2}
          label={muted ? "取消静音" : "静音"}
          pressed={muted}
          onClick={runAndClose(onToggleMuted)}
        />
        <PlayerToolTile icon={RefreshCw} label="重新加载" onClick={runAndClose(onRefresh)} />
        <PlayerToolTile icon={Film} label="抖音推荐" onClick={runAndClose(() => navigate("/shorts/douyin"))} />
      </div>
    </PlayerHudOverflowMenu>
  );
}

/**
 * 评论与详情抽屉的开关状态。
 *
 * 换片时一律关掉：抽屉里的内容属于上一条。两个抽屉共用一处状态是因为它们互斥 ——
 * 竖屏上同时开两层浮层没有可用的空间。
 */
function useShortsPanels(item: { aid: string } | null) {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const aid = item?.aid ?? "";
  const [settledAid, setSettledAid] = useState(aid);
  if (settledAid !== aid) {
    setSettledAid(aid);
    setCommentsOpen(false);
    setDetailOpen(false);
  }
  const openComments = useCallback(() => {
    if (aid) {
      setDetailOpen(false);
      setCommentsOpen(true);
    }
  }, [aid]);
  const openDetail = useCallback(() => {
    setCommentsOpen(false);
    setDetailOpen(true);
  }, []);
  return useMemo(
    () => ({
      aid,
      commentsOpen,
      detailOpen,
      anyOpen: commentsOpen || detailOpen,
      openComments,
      openDetail,
      setCommentsOpen,
      setDetailOpen,
    }),
    [aid, commentsOpen, detailOpen, openComments, openDetail],
  );
}

function ShortsBackButton({
  onClick,
  inline,
  label = "返回上一页",
  showDouyinEntry = false,
}: {
  onClick: () => void;
  inline?: boolean;
  label?: string;
  /** 仅失败或空态提供备用入口，首次加载不闪现平台切换按钮。 */
  showDouyinEntry?: boolean;
}) {
  return (
    <>
    {!inline && showDouyinEntry && (
      <Link to="/shorts/douyin" className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "absolute top-3 right-3 z-10")}>
        抖音推荐
      </Link>
    )}
    <MediaButton
      type="button"
      aria-label={label}
      title={label}
      // 加载、错误和空态没有外层皮肤，需自行提供同一套尺寸与颜色令牌。
      className={cn(
        PLAYER_HUD_BUTTON_CLASS,
        !inline && SHORTS_TOP_CONTROLS_CLASS,
        !inline && "absolute top-3 left-3 z-10",
      )}
      onClick={onClick}
    >
      <ChevronLeft className={PLAYER_HUD_ICON_CLASS} data-icon="inline-start" aria-hidden />
    </MediaButton>
    </>
  );
}
