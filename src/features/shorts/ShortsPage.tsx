import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, MessageSquareOff, UserRoundX } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { CommentsPanel } from "@/features/video/CommentsPanel";
import { videoGetArchive, videoGetPlayerMeta } from "@/features/video/videoApi";
import { formatRelativeTime } from "@/features/video/videoHistory";
import {
  VIDEO_HOME_PATH,
  videoDetailsNavigationState,
  videoPlayPath,
  videoShortsEntryFromState,
  type VideoShortsEntry,
} from "@/features/video/videoRoute";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerScope,
  DrawerTitle,
  DrawerViewport,
} from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/shared/components/ErrorState";
import { BilibiliAppAuthAction } from "@/shared/components/BilibiliAppAuthAction";
import type { VideoChapter, VideoItem, VideoUploaderStoryItem } from "@/shared/types/video";
import { ShortsStageSkeleton } from "./ShortsStageSkeleton";
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
import {
  ANDROID_BACK_EVENT,
  DISMISSIBLE_POPUP_SELECTOR,
  hasBrowserHistoryEntry,
} from "@/app/androidBackNavigation";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import { notify } from "@/components/ui/toast";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { ShortsBackButton, ShortsPanelChrome } from "./ShortsPanelChrome";
import { ShortsSeekBridge, ShortsSeekPlayer } from "./shortsSeekPlayer";
import { ShortsBlankStage, ShortsStage } from "./ShortsStage";
import { shortsUploaderCounter } from "./shortsUploaderFeed";
import {
  SHORTS_SAFE_AREA_BOTTOM,
  shortsCommentDockHeight,
  SHORTS_SEED_PARAM,
  SHORTS_SLOT_IDS,
  shortsItemKey,
  shortsMountedIndexes,
  shortsPath,
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
import type { ShortsDanmakuState } from "./useShortsDanmaku";
import type { ShortsPlaybackState } from "./useShortsPlayback";

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
 * 播放与弹幕状态住在页面层：评论/详情抽屉、章节查询与 Storyboard 都只服务当前条目。
 * 每个槽位面板仍各自渲染完整界面，并让顶部栏、信息、进度条与底栏和画面共享现有
 * 条带 transform，滑动时整个界面一起跟手移动。
 *
 * ## 三播放器槽位
 *
 * 三个面板按槽位挂载（key 恒定 `slot-a` / `slot-b` / `slot-c`），换片只改变它们
 * 各自持有哪一条与谁在播。被提升为活动的那个槽位已经预热好，因此换片不重新取流、
 * 不重建播放器（见 `useShortsSlots`）。
 */
export function ShortsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  /**
   * 入口种子：从播放页「短视频」进来时带 `?seed=<bvid>`，以那条为起点开流。
   * 只作首屏初值；条目到位后由下面的 effect 接手，改成「当前正在看的那条」。
   */
  const [searchParams] = useSearchParams();
  const entrySeed = searchParams.get(SHORTS_SEED_PARAM);
  // 自动入口把播放页 replace 掉了，失败时唯一的「回到那条视频」线索就在这里。
  // 只认合法形状：深链、手动进入与历史前进后退都没有它。
  const entrySource = videoShortsEntryFromState(useLocation().state);
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
  const coarsePointer = useCoarsePointer();
  const compact = useCompactPlayerViewport();
  const compactOrTouch = compact || coarsePointer;

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
  /**
   * 评论 dock：紧凑视口里评论区不再是盖住画面的浮层，而是占真实布局高度的下栏。
   *
   * 外层把「视口」切成上下两段（播放区 + dock），舞台只量到播放区，因此画面会自己
   * 缩小、等比内切进剩下的空间 —— 不需要给播放器或手势层任何缩放逻辑。
   *
   * `commentsOpen` 与 dock 高度分开记：关闭时高度要保留到退场动画结束（
   * `onOpenChangeComplete`），否则抽屉还没滑完、画面就已经扩张到它下面。快速重开
   * 时 `open` 先变 true，释放计时被取消，不会出现「开着开着突然收走一截」。
   */
  // 量外层（播放区 + dock 的总高），不是播放区自己：dock 占位后播放区变矮，
  // 若按它算占比会在「打开 → 变矮 → 算出更小的 dock → 再变矮」里循环。
  //
  // 直接传外层高度，不再减底部操作栏：dock 打开时那条栏连同顶栏、信息浮层一起收起
  // （画面区只剩画面本身），播放区的可用高度就是外层的整条高度。这样 60% 这个比例
  // 说的就是「评论区占视口六成」，与用户看到的一致。
  //
  // 安全区不用再减：外层的高度来自 `.app-shell` 已经扣掉状态栏/手势条的可用视口。
  const { size: dockShellSize, measure: measureDockShell } = useDockShellSize();
  const dockStageHeight = Math.max(0, dockShellSize.height);
  const dockCandidate = compact ? shortsCommentDockHeight(dockStageHeight) : 0;
  /**
   * 退场期间仍在保留的 dock 高度；0 表示没有占位。
   *
   * 关闭时**不立刻**归零：抽屉要往下滑出 dock，画面也必须等它滑完再扩张，
   * 否则两层在动画中途重叠。`onOpenChangeComplete` 收到 false 才清零。
   */
  const [retainedDockHeight, setRetainedDockHeight] = useState(0);
  // 打开时立刻占位（并把上一轮退场残留清掉，快速重开不会先收窄再展开）。
  // 在事件里写：`onOpenChange` 是唯一改变打开态的地方，effect 里同步 state 会
  // 多跑一轮渲染，且 `enabled` 的切换不该由外部状态驱动。
  const setPanelsCommentsOpen = panels.setCommentsOpen;
  const setCommentsOpen = useCallback(
    (open: boolean) => {
      if (open) setRetainedDockHeight(dockCandidate);
      setPanelsCommentsOpen(open);
    },
    [dockCandidate, setPanelsCommentsOpen],
  );
  // 退场保留值要按当前视口收口：旋转或键盘把可用高度改小后，旧值可能大于现在的
  // 候选高度；若不夹住，收起的 dock 会在播放区下方留一截空栏（甚至超过剩余空间）。
  const dockHeight = panels.commentsOpen
    ? dockCandidate
    : Math.min(retainedDockHeight, dockCandidate);
  const commentsDockActive = compact && dockHeight > 0;
  // 评论 dock 打开期间，每个 panel 都由 `ShortsSlotPanel` 同时收起整块控件；
  // 退出动画结束、dock 高度归零后才恢复，避免两层在动画中途重叠。
  /**
   * 评论是否走 dock 形态。
   *
   * 紧凑视口且量得到可用高度时恒走 dock（打开、退场期间都是），没有可用高度
   * （极矮视口）时退回整窗口抽屉 —— 那种高度下留不出画面，dock 也就失去意义。
   */
  const commentsInDock = compact && dockCandidate > 0;

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
    onContextMenu,
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
    else navigate(VIDEO_HOME_PATH, { replace: true });
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
    // 离开即卸载，推荐流缓存（`gcTime: 0`）随之丢弃，Back 回来按 URL 的 seed 重新开流。
    // 先把本条目的 seed 换成正在看的这条，否则会回到进入短视频时的那条。
    // 只改 URL，保留 React Router 的 idx/key/usr，不触发一次中间导航。
    window.history.replaceState(window.history.state, "", shortsPath(current.bvid));
    navigate(
      videoPlayPath({
        bvid: current.bvid,
        cid: current.cid ?? 0,
        epId: null,
        title: current.title,
        aid: current.aid,
      }),
      { state: videoDetailsNavigationState(`${current.bvid}:${current.cid ?? 0}`) },
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
        // 浮层（不是它的后代），因此拿不到这里外壳补的安全区，得自己让位。底部形态
        // （dock 与整窗口两种）都是页面最底层，安全区由它自己消费。
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
    // 首屏加载：视频区留黑，顶部/底部 chrome 与左下信息骨架先占住成品位置。
    // 返回口通过 slot 交给轻量骨架组件，避免让路由级骨架依赖完整面板控件。
    return (
      <div className="relative h-full min-h-0">
        <ShortsStageSkeleton
          label="正在加载短视频…"
          back={<ShortsBackButton onClick={goBack} inline />}
        />
      </div>
    );
  }

  if (feedQuery.isError && items.length === 0) {
    return (
      <div className="relative flex h-full min-h-0 flex-col items-center justify-center bg-black px-6">
        <ShortsBackButton onClick={goBack} />
        <ErrorState
          error={feedQuery.error}
          title="短视频加载失败"
          onRetry={() => void feedQuery.refetch()}
          action={
            <>
              <BilibiliAppAuthAction error={feedQuery.error} />
              {entrySource && <ShortsSourceBackButton entry={entrySource} />}
            </>
          }
          className="max-w-md"
        />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="relative flex h-full min-h-0 flex-col items-center justify-center bg-black">
        <ShortsBackButton onClick={goBack} />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquareOff aria-hidden />
            </EmptyMedia>
            <EmptyTitle>暂时没有短视频</EmptyTitle>
            <EmptyDescription>上游轮换流这一批没有可播条目，稍后再试。</EmptyDescription>
          </EmptyHeader>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="outline" onClick={() => void feedQuery.refetch()}>
              重新加载
            </Button>
            {entrySource && <ShortsSourceBackButton entry={entrySource} />}
          </div>
        </Empty>
      </div>
    );
  }

  const mounted = shortsMountedIndexes(index, items.length);
  /** 挂载窗口里由槽位面板承担的下标；其余渲染空舞台占位。 */
  const slotCovered = shortsSlotCoveredIndexes(slots);
  const slotIds: ShortsSlotId[] = [...SHORTS_SLOT_IDS];

  const uploaderTotal = feed.uploaderQuery.data?.pages[0]?.total ?? 0;
  const uploaderCounterFor = (item: VideoItem) =>
    feed.uploaderMode
      ? feed.uploaderReady
        ? shortsUploaderCounter(item as VideoUploaderStoryItem, uploaderTotal)
        : feed.uploaderQuery.isError
          ? "UP 主列表"
          : "加载中…"
      : null;
  const uploaderStatus: ReactNode = feed.uploaderMode ? (
    <>
      {!feed.uploaderReady && feed.uploaderQuery.isError && (
        <ErrorState
          error={feed.uploaderQuery.error}
          title="UP 主列表加载失败"
          onRetry={() => {
            if (!feed.uploaderQuery.isFetching)
              void feed.uploaderQuery.refetch({ cancelRefetch: false });
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
        <span role="status" className="rounded-md bg-black/75 px-3 py-1">
          正在加载{feed.uploaderQuery.isFetchingPreviousPage ? "前面" : "后面"}的条目…
        </span>
      )}
    </>
  ) : null;

  return (
    <ShortsSeekPlayer>
      {/*
        评论 dock 的挂载范围：紧凑视口里评论区从整窗口浮层改为播放区之下的真实下栏。
        范围必须包住下面两段（播放区与 dock 本身），且**始终存在** —— 抽屉打开时
        `Drawer` 才会取到容器，关闭时容器消失会让它退回整窗口浮层，退场动画因此
        从下栏跳到屏幕底部。`DrawerScope` 只是个 context，不改变布局。
      */}
      <DrawerScope side="bottom">
        <div ref={measureDockShell} className="flex h-full min-h-0 flex-col">
          <div
            ref={viewportRef}
            data-slot="shorts-viewport"
            // 播放区与 dock 是外层 flex 列的两段：dock 固定高度、播放区吃掉剩余空间。
            // 舞台只量到这一块，评论打开时画面据此等比内切进变矮的区域；关闭后
            // dock 高度归还，几何回到整视口。
            data-feed-mode={feed.uploaderMode ? "uploader" : "recommendation"}
            data-current-aid={current?.aid}
            // `media-skin` 提供 `--media-*` 令牌（白字 + 白色半透明悬停底）。复用播放器
            // HUD 的溢出菜单需要它：那些控件的配色走令牌，不在这个作用域里会落到应用
            // 前景色 —— 在黑舞台上变成看不见的深色图标。
            //
            // `select-none` 是长按倍速的前提：画面上没有任何可选文本，而 Android WebView
            // 的长按一旦命中文字节点就会改走「选择文字」分支，我们的计时器再触发也只会
            // 被系统菜单盖住。与播放页画面同一处理（那里还多一层 `touch-none`）。
            // 评论抽屉走 portal、底部发送框是输入框，都不受影响，正文仍可选择。
            className="media-skin relative min-h-0 flex-1 select-none overflow-hidden bg-black"
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
            onContextMenu={onContextMenu}
          >
            <div ref={trackRef} data-slot="shorts-track" className="relative h-full">
              {/*
            槽位面板：key 恒定（`slot-a` / `slot-b` / `slot-c`），换片只改变
            `top` 与角色。

            这是播放器复用的前提 —— key 变化会卸载重建面板与 `<video>`，那样预
            热省下的取流时间会重新花在 DOM 与引擎的重建上。`style` 变化不触发
            remount，因此同一份 `<video>` 与 Video.js 实例跨换片存活。

            三个槽位都渲染完整面板：两个预热槽位分别在前后邻居上缓冲到 `canplay`，
            换片与回滑时画面、信息和控制栏已经按同一条轨道排好。
          */}
              {slotIds.map((slotId) => {
                const held = slots.held[slotId];
                if (held == null) return null;
                const item = items[held];
                if (!item) return null;
                const active = slotId === slots.active;
                const panelUploaderCounter = uploaderCounterFor(item);
                // 离场面板只读已缓存章节，不因预热或离场排队新的 player meta 请求。
                const cachedChapters = queryClient.getQueryData<{
                  chapters?: readonly VideoChapter[];
                }>(["video_player_meta", item.cid ?? 0, item.bvid, ""])?.chapters;
                return (
                  <ShortsSlotPanel
                    key={`slot-${slotId}`}
                    slotId={slotId}
                    held={held}
                    item={item}
                    active={active}
                    playback={slotStates[slotId]}
                    videoRef={slotRefs[slotId]}
                    danmaku={danmaku}
                    danmakuVisible={danmakuVisible}
                    gestureActive={gestureActive}
                    commentsDockActive={commentsDockActive}
                    onSurfaceTap={onSurfaceTap}
                    renderChrome={(measuredChromeColumn, progressSnapshot) => (
                      <ShortsPanelChrome
                        item={item}
                        playback={slotStates[slotId]}
                        active={active}
                        compact={compact}
                        compactOrTouch={compactOrTouch}
                        chromeColumn={coarsePointer ? measuredChromeColumn : 0}
                        infoVisible={infoVisible}
                        danmakuVisible={danmakuVisible}
                        chapters={active ? chapters : cachedChapters}
                        thumbnails={active ? thumbnails : []}
                        warmProgressSeconds={progressSnapshot.currentTime}
                        warmDurationSeconds={progressSnapshot.duration}
                        chapterMenuOpen={active && chapterMenuOpen}
                        commentsOpen={active && panels.commentsOpen}
                        uploaderMode={feed.uploaderMode}
                        uploaderCounter={panelUploaderCounter}
                        uploaderStatus={active ? uploaderStatus : null}
                        navigationLocked={feed.navigationLocked}
                        index={held}
                        itemCount={items.length}
                        hasPreviousPage={feed.hasPreviousPage}
                        hasNextPage={feed.hasNextPage}
                        viewportRef={viewportRef}
                        onBack={goBack}
                        onEnterUploader={feed.enterUploader}
                        onOpenComments={() => setCommentsOpen(true)}
                        onOpenDetail={panels.openDetail}
                        onOpenInPlayer={openInPlayer}
                        onArmSeek={armSeek}
                        onChapterMenuOpenChange={setChapterMenuOpen}
                        onToggleDanmaku={() => setDanmakuVisible((value) => !value)}
                        onToggleInfo={() => setInfoVisible((value) => !value)}
                        onPrevious={() => goToIndex(index - 1)}
                        onNext={() => goToIndex(index + 1)}
                      />
                    )}
                  />
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
                    <ShortsBlankStage
                      item={item}
                      safeAreaBottom={!commentsDockActive}
                      bottomBar={!commentsDockActive}
                    />
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
          </div>

          {/*
        评论 dock（仅紧凑视口 + 评论打开/退场期间）：占真实高度，不再是盖住画面的
        浮层。抽屉本身走 portal 挂进本层的 `DrawerViewport`（`absolute inset-0`），
        因此它的进出动画、圆角与宽度都以这块下栏为边界。
      */}
          {commentsInDock && (
            <div
              data-slot="shorts-comments-dock"
              className={cn(
                "relative min-h-0 shrink-0 overflow-hidden bg-popover",
                // 关闭且高度归零后不再画分隔线，否则底栏上方会常驻一条 1px 的边。
                commentsDockActive && "border-t border-white/10",
              )}
              // dock 打开时底部操作栏整条收起，dock 是页面最底层：安全区由它消费一次
              // （`ShortsDrawerContent` 的滚动容器与二级回复抽屉各补一份）。舞台侧
              // 同时停掉对操作栏与安全区的让位，见 `bottomBar={!commentsDockActive}`。
              //
              // 关闭时保留 0 高占位而不是卸载：`DrawerViewport` 必须在第一次打开之前
              // 就已挂载，否则 `Drawer` 首帧拿到 null 容器会先 portal 到 body，再切回
              // dock —— 退场时也可能反向跳一次。
              style={{ height: `${dockHeight}px` }}
            >
              <DrawerViewport />
              <Drawer
                open={panels.commentsOpen}
                onOpenChange={setCommentsOpen}
                // 非模态：点视频只做视频自己的事（播放/暂停），不收起评论 —— dock 里
                // 画面在抽屉外面，base-ui 的 outside-press 默认会把它当成「点外面」。
                // 关闭走表头按钮、系统 Back 与 Escape。
                disablePointerDismissal
                onOpenChangeComplete={(open) => {
                  // 退场动画结束后才把高度还给画面：否则抽屉还在往下滑，画面已经
                  // 扩张到它下面，两层重叠一帧。快速重开时此回调不会以 false 到达
                  // （`open` 已是 true），dock 不会中途收窄。
                  if (!open) setRetainedDockHeight(0);
                }}
              >
                <ShortsDrawerContent compact title="评论" scoped>
                  {commentsBody}
                </ShortsDrawerContent>
              </Drawer>
            </div>
          )}
        </div>
      </DrawerScope>

      {/*
        以下抽屉都在视口**之外**。

        React 的合成事件按组件树冒泡，与 portal 把 DOM 挂到哪儿无关：放在视口
        div 里面时，抽屉内的滚动与拖动会先经过视口的 pointer 捕获处理器，被当成
        换片手势吃掉。移出来之后抽屉不再是视口的 React 后代，事件不再经过它。

        非 dock 形态的评论抽屉（桌面宽视口与极矮视口）与详情抽屉都是整窗口浮层；
        紧凑视口的评论走上面的 dock（`commentsInDock`）。
      */}
      {!commentsInDock && (
        <Drawer open={panels.commentsOpen} onOpenChange={setCommentsOpen}>
          <ShortsDrawerContent compact={compact} title="评论">
            {commentsBody}
          </ShortsDrawerContent>
        </Drawer>
      )}
      <Drawer open={panels.detailOpen} onOpenChange={panels.setDetailOpen}>
        <ShortsDrawerContent compact={compact} title="视频详情">
          {detailBody}
        </ShortsDrawerContent>
      </Drawer>
    </ShortsSeekPlayer>
  );
}

type ShortsSlotPanelProps = {
  slotId: ShortsSlotId;
  held: number;
  item: VideoItem;
  active: boolean;
  playback: ShortsPlaybackState;
  videoRef: RefObject<HTMLVideoElement | null>;
  danmaku: ShortsDanmakuState;
  danmakuVisible: boolean;
  gestureActive: boolean;
  commentsDockActive: boolean;
  onSurfaceTap: () => void;
  renderChrome: (chromeColumn: number, progress: ShortsWarmProgress) => ReactNode;
};

type ShortsWarmProgress = {
  currentTime: number;
  duration: number;
};

type ShortsWarmSnapshot = ShortsWarmProgress & { itemKey: string };

const EMPTY_SHORTS_WARM_PROGRESS: ShortsWarmProgress = { currentTime: 0, duration: 0 };

/**
 * 一个可复用播放器槽位及其完整界面。
 *
 * key 由页面固定为 `slot-a/b/c`，这里把舞台、信息与控制栏放进同一个
 * `shorts-panel`，现有手势层只移动 track，因此所有可见元素共享完全一致的位移与
 * 纵深，不另建 transform 或逐帧同步。控件列宽度也按本槽位的画面框各自测量。
 */
function ShortsSlotPanel({
  slotId,
  held,
  item,
  active,
  playback,
  videoRef,
  danmaku,
  danmakuVisible,
  gestureActive,
  commentsDockActive,
  onSurfaceTap,
  renderChrome,
}: ShortsSlotPanelProps) {
  const itemKey = shortsItemKey(item);
  const [chromeColumn, setChromeColumn] = useState(0);
  const [warmSnapshot, setWarmSnapshot] = useState<ShortsWarmSnapshot>({
    itemKey,
    currentTime: 0,
    duration: 0,
  });
  const wasActiveRef = useRef(active);

  useLayoutEffect(() => {
    const leftActive = wasActiveRef.current && !active;
    wasActiveRef.current = active;
    if (!leftActive) return;
    const media = videoRef.current;
    if (!media) return;
    const duration =
      Number.isFinite(media.duration) && media.duration > 0 ? media.duration : playback.duration;
    const currentTime =
      Number.isFinite(media.currentTime) && media.currentTime >= 0 ? media.currentTime : 0;
    const next = {
      itemKey,
      currentTime: duration > 0 ? Math.min(currentTime, duration) : currentTime,
      duration: duration > 0 ? duration : 0,
    };
    setWarmSnapshot((current) =>
      current.itemKey === next.itemKey &&
      current.currentTime === next.currentTime &&
      current.duration === next.duration
        ? current
        : next,
    );
  }, [active, itemKey, playback.duration, videoRef]);

  const warmProgress = warmSnapshot.itemKey === itemKey ? warmSnapshot : EMPTY_SHORTS_WARM_PROGRESS;

  return (
    <div
      data-slot="shorts-panel"
      data-slot-id={slotId}
      data-item-key={shortsItemKey(item)}
      aria-hidden={active ? undefined : true}
      inert={active ? undefined : true}
      className="absolute inset-x-0 h-full"
      // 条目按绝对下标定位，换片不移动其中任何一个：收尾只动 track。
      style={{ top: shortsSlotTop(held) }}
    >
      <ShortsStage
        item={item}
        playback={playback}
        videoRef={videoRef}
        mode={active ? "play" : "warm"}
        danmaku={danmaku}
        danmakuVisible={danmakuVisible}
        gestureActive={gestureActive}
        // 评论 dock 打开时整块控件让位，画面铺到 dock 上沿；安全区由 dock 消费。
        safeAreaBottom={!commentsDockActive}
        bottomBar={!commentsDockActive}
        onSurfaceTap={onSurfaceTap}
        onChromeColumn={setChromeColumn}
      />
      {!commentsDockActive && renderChrome(chromeColumn, warmProgress)}
    </div>
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
  scoped = false,
}: {
  compact: boolean;
  title: string;
  children: React.ReactNode;
  /** 挂在 `DrawerViewport`（评论 dock）里：尺寸与侧别都由那块容器决定。 */
  scoped?: boolean;
}) {
  // 评论 dock 是一条横栏，从下方推入；整窗口形态仍按视口宽窄决定侧别。
  const side = scoped ? "bottom" : panelDrawerSide(compact);
  return (
    <DrawerContent
      side={side}
      className={cn(
        "flex flex-col overflow-hidden p-0",
        // dock 形态铺满下栏：基础组件的底部抽屉带 `max-w-[36rem]`，平板横屏的
        // dock 比它宽，不覆盖会在两侧露出下面的画面。
        scoped && "max-w-full",
        panelDrawerSizeClass(side, scoped),
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <DrawerTitle>{title}</DrawerTitle>
        {/* 明确的关闭入口：dock 形态下视频点按不再收起评论（那是播放/暂停），
            系统 Back / Escape 之外必须有一个看得见的口。 */}
        <DrawerClose
          render={<Button variant="ghost" size="icon-sm" aria-label="关闭" title="关闭" />}
        >
          <ChevronDown aria-hidden />
        </DrawerClose>
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
        // dock 形态是页面最底层（底部操作栏在它打开时整条收起），安全区得由它自己
        // 消费 —— 不补的话手机上最后一条评论会压在系统手势条下面。
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
          {formatOnline(item.view)} 次播放，{formatOnline(item.danmaku)} 条弹幕
          {item.pubdate > 0 ? `，${formatRelativeTime(item.pubdate)}发布` : ""}
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
              {formatOnline(archive.author_fans)} 粉丝，{formatOnline(archive.author_videos)} 投稿
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
 * 评论 dock 外层的尺寸（播放区 + dock 的总高）。
 *
 * 与 `ShortsStage` 里量画面区的 ref 同构，但这里量的是**外层**：按播放区自己算
 * 占比会在「打开 → 播放区变矮 → 算出更小的 dock → 再变矮」里循环。
 */
function useDockShellSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const apply = () => {
      const { clientWidth, clientHeight } = node;
      setSize((current) =>
        current.width === clientWidth && current.height === clientHeight
          ? current
          : { width: clientWidth, height: clientHeight },
      );
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { size, measure };
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

/**
 * 从自动入口回原视频详情的出口。
 *
 * 只在首屏真正失败时出现：短视频流按 seed 与推荐窗口取内容，上游拒绝（凭据失效、
 * 风控）或这一轮没有可播条目时，用户手里那条视频本来是能看的 —— 回到它，而不是
 * 让人对着一个无法自解释的推荐流反复重试。
 *
 * 回详情时带上「详情意图」：自动入口看到它会留在播放页，不会立刻再把人推回来。
 * replace 而不是 push：短视频这一条是自动入口压进来/换进来的，恢复应当把它换掉，
 * 否则 Back 会退回同一个失败页。
 */
function ShortsSourceBackButton({ entry }: { entry: VideoShortsEntry }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="outline"
      onClick={() =>
        navigate(
          videoPlayPath({
            bvid: entry.bvid,
            cid: entry.cid,
            title: entry.title,
            aid: entry.aid,
          }),
          {
            replace: true,
            state: videoDetailsNavigationState(entry.videoKey),
          },
        )
      }
    >
      回到视频详情
    </Button>
  );
}
