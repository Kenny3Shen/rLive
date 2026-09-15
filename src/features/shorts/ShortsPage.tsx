import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ExternalLink,
  Info,
  MessageCircle,
  MessageSquare,
  MessageSquareOff,
  RefreshCw,
  ScrollText,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { DanmakuComposer } from "@/features/room/BilibiliDanmakuComposer";
import { CommentsPanel } from "@/features/video/CommentsPanel";
import { videoGetArchive, videoGetStory } from "@/features/video/videoApi";
import { formatRelativeTime, formatVideoDuration } from "@/features/video/videoHistory";
import { videoPlayPath } from "@/features/video/videoRoute";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/shared/components/ErrorState";
import { PlayerStageLoading } from "@/shared/components/player/PlayerStageLoading";
import { PlayerHudOverflowMenu, PlayerToolTile } from "@/shared/components/player/PlayerHudMenu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { prefersReducedMotion, SWIPE_SETTLE_EASING } from "@/shared/motion/tokens";
import { hasBrowserHistoryEntry } from "@/app/androidBackNavigation";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import { ShortsSeekBar } from "./ShortsSeekBar";
import { ShortsPoster, ShortsStage } from "./ShortsStage";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_BOTTOM_CONTROLS_HEIGHT_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SAFE_AREA_TOP,
  SHORTS_SWIPE_VELOCITY_WINDOW_MS,
  SHORTS_TOP_BAR_HEIGHT_PX,
  shortsFeedItems,
  shortsItemKey,
  shortsMountedIndexes,
  shortsShouldFetchMore,
  shortsSwipeDragOffset,
  shortsSwipeIntent,
  shortsSwipeSettleDuration,
  shortsSwipeTargetIndex,
  shortsSwipeVelocity,
  shortsTrackOffset,
  type ShortsSwipeSample,
} from "./shortsFeed";
import { useShortsDanmaku } from "./useShortsDanmaku";
import { useShortsPlayback } from "./useShortsPlayback";

/**
 * `/shorts`：B 站短视频（story feed）的竖屏消费页。
 *
 * 沉浸式路由（无侧栏、无顶栏，见 `immersiveRoutes`），返回口是顶部控制栏的
 * 悬浮箭头，与其他沉浸播放页同一位置同一画法。
 *
 * 上游是**无游标轮换流**：没有页码也没有总数，「加载更多」= 再拉一批并跨页去重，
 * 因此这一页永远不知道自己有多长。最后一条上的越界阻尼是「暂时到底」的反馈，
 * 不是终点声明；剩余不足 `SHORTS_PREFETCH_REMAINING` 条就提前补货。
 *
 * 播放与弹幕状态住在这一层而不是舞台里：顶部控制栏与底部操作栏必须固定在视口上
 * （随条带平移的话，换片时它们会跟着滑走），而它们要读 `muted`、`currentTime`
 * 与弹幕开关 —— 状态因此只能放在两者共同的祖先。舞台是纯展示层。
 */
export function ShortsPage() {
  const navigate = useNavigate();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  /**
   * 活动条目的媒体元素。
   *
   * 由页面持有、传给活动舞台：起播链路（`useShortsPlayback`）也在这一层。换片时
   * 舞台按 `shortsItemKey` 换 key 重新挂载，因此这个 ref 会指向新的 `<video>` ——
   * 播放 effect 依赖 cid/playUrl，在 React 提交完新节点之后才重跑，读到的一定是新的。
   */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [rawIndex, setIndex] = useState(0);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [infoVisible, setInfoVisible] = useState(true);
  const [gestureActive, setGestureActive] = useState(false);
  const compact = useCompactPlayerViewport();

  const feedQuery = useInfiniteQuery({
    queryKey: ["shorts_story"],
    initialPageParam: 1,
    queryFn: () => videoGetStory(),
    // 上游无游标：页码只是本地的「再来一批」计数，has_more 恒为「这批非空」。
    getNextPageParam: (lastPage, allPages) => (lastPage.has_more ? allPages.length + 1 : undefined),
    // 轮换流不该被缓存复用：回到这一页应该看到新内容。
    staleTime: 0,
    gcTime: 0,
  });

  const items = shortsFeedItems(feedQuery.data?.pages ?? []);
  // 流缩短（重新拉取）时把下标收回范围内，避免指向不存在的条目。
  // 在渲染期派生而不是放进 effect：effect 里 setState 会先用越界下标渲染一帧（空舞台）。
  const index = items.length > 0 ? Math.min(rawIndex, items.length - 1) : rawIndex;
  const current = items[index] ?? null;

  /* ---------- 播放、弹幕与抽屉 ---------- */

  const danmaku = useShortsDanmaku(current?.cid ?? 0, danmakuVisible);
  const playback = useShortsPlayback({
    item: current,
    videoRef,
    active: true,
    onProgress: danmaku.ensure,
  });
  const panels = useShortsPanels(current);

  // 提前补货：等滑到最后一条再拉必然要等（story 单批只给 4~5 条）。
  useEffect(() => {
    if (
      shortsShouldFetchMore(
        index,
        items.length,
        feedQuery.hasNextPage,
        feedQuery.isFetchingNextPage,
      )
    ) {
      void feedQuery.fetchNextPage();
    }
  }, [feedQuery, index, items.length]);

  /* ---------- 纵向翻页：手指按下期间直接写 transform，释放交给合成器 ---------- */

  const offsetRef = useRef(0);
  const animationRef = useRef<Animation | null>(null);
  const stageHeightRef = useRef(0);
  const swipeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startOffset: number;
    stageHeight: number;
    index: number;
    length: number;
    /** 已锁定为纵向手势。锁定前不移动条带，也不拦子元素的点按。 */
    vertical: boolean;
    samples: ShortsSwipeSample[];
  } | null>(null);

  const stageHeight = useCallback(() => {
    const measured = viewportRef.current?.clientHeight ?? 0;
    if (measured > 0) stageHeightRef.current = measured;
    return stageHeightRef.current;
  }, []);

  const writeOffset = useCallback((offset: number) => {
    offsetRef.current = offset;
    const el = trackRef.current;
    if (el) el.style.transform = `translate3d(0, ${offset}px, 0)`;
  }, []);

  /** 在当前位置停止收尾，把该偏移留下作为内联样式。 */
  const cancelSettle = useCallback(() => {
    const animation = animationRef.current;
    if (!animation) return;
    const el = trackRef.current;
    let stoppedAt = offsetRef.current;
    if (el) {
      const computed = window.getComputedStyle(el).transform;
      if (computed && computed !== "none") {
        try {
          stoppedAt = new DOMMatrixReadOnly(computed).m42;
        } catch {
          // 取不到实时矩阵时退回记账值：比跳到终点温和。
        }
      }
    }
    animationRef.current = null;
    writeOffset(stoppedAt);
    animation.cancel();
  }, [writeOffset]);

  /**
   * 把剩余行程交给合成器。
   *
   * 刻意用 Web Animations 而不是 rAF 补间：换片会触发一次 React 提交（拆旧播放器、
   * 建新播放器），主线程上的补间会被那次提交吞掉大部分帧 —— 那正是「先瞬间切换、
   * 再滑一下」的观感来源。`fill: both` 让第一个关键帧立即生效，条带不会绘制出
   * 未变换的一帧。
   */
  const settle = useCallback(
    (target: number, duration: number) => {
      const el = trackRef.current;
      if (!el) return;
      cancelSettle();
      const from = offsetRef.current;
      if (duration <= 0 || from === target || prefersReducedMotion()) {
        offsetRef.current = target;
        el.style.transform = `translate3d(0, ${target}px, 0)`;
        el.style.willChange = "";
        return;
      }
      offsetRef.current = target;
      el.style.willChange = "transform";
      const animation = el.animate(
        [
          { transform: `translate3d(0, ${from}px, 0)` },
          { transform: `translate3d(0, ${target}px, 0)` },
        ],
        { duration, easing: SWIPE_SETTLE_EASING, fill: "both" },
      );
      animationRef.current = animation;
      void animation.finished
        .then(() => {
          if (animationRef.current !== animation) return;
          animationRef.current = null;
          // 先写内联样式再取消动画：顺序颠倒会让部分 Android 合成器画出一帧未变换的层。
          el.style.transform = `translate3d(0, ${target}px, 0)`;
          animation.cancel();
          el.style.willChange = "";
        })
        .catch(() => {
          // 新手势或新下标打断时预期会取消。
        });
    },
    [cancelSettle],
  );

  /** 把条带停靠在当前下标处，不做运动（挂载、尺寸变化、下标被外部改动）。 */
  const parkTrack = useCallback(() => {
    if (swipeRef.current?.vertical) return;
    cancelSettle();
    const target = shortsTrackOffset(index, stageHeight());
    writeOffset(target);
    const el = trackRef.current;
    if (el) el.style.willChange = "";
  }, [cancelSettle, index, stageHeight, writeOffset]);

  useLayoutEffect(() => {
    parkTrack();
  }, [parkTrack]);

  // 视口高度变化（旋转、系统栏、软键盘）要重建纵向基准，否则第一条之后的
  // 条目会整个被推出屏幕。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    let applied = 0;
    const observer = new ResizeObserver(() => {
      const height = viewport.clientHeight;
      // 只有高度变化才重建：手势进行中一律不动，避免把运行中的动画跳到终点。
      if (height <= 0 || height === applied || swipeRef.current?.vertical) return;
      applied = height;
      stageHeightRef.current = height;
      cancelSettle();
      writeOffset(shortsTrackOffset(index, height));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [cancelSettle, index, writeOffset]);

  useEffect(
    () => () => {
      const animation = animationRef.current;
      animationRef.current = null;
      animation?.cancel();
    },
    [],
  );

  /** 跳到某一条：已挂载的目的条先开始平移，再通知 React。 */
  const goToIndex = useCallback(
    (next: number, velocity = 0) => {
      if (next < 0 || next >= items.length || next === index) return;
      const target = shortsTrackOffset(next, stageHeight());
      settle(target, shortsSwipeSettleDuration(target - offsetRef.current, velocity));
      setIndex(next);
    },
    [index, items.length, settle, stageHeight],
  );

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pointerType = event.pointerType as string;
      // 部分 Android WebView 对手指输入上报空的 pointerType。鼠标不参与换片
      // （桌面用滚轮与方向键，见下）。
      if ((pointerType !== "touch" && pointerType !== "") || !event.isPrimary) return;
      // 进度条上的按压归它自己：那是唯一的横向精细操作，纵向抖动不该换片。
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-slot="shorts-seek"]')
      ) {
        return;
      }
      swipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        // 临时值：收尾可能仍在跑，其达到的偏移只在锁定为纵向时才读。
        startOffset: offsetRef.current,
        stageHeight: stageHeight() || event.currentTarget.clientHeight,
        index,
        length: items.length,
        vertical: false,
        samples: [{ y: event.clientY, time: performance.now() }],
      };
    },
    [index, items.length, stageHeight],
  );

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - swipe.startX;
      const deltaY = event.clientY - swipe.startY;

      if (!swipe.vertical) {
        const intent = shortsSwipeIntent(deltaX, deltaY);
        if (intent === "pending") return;
        if (intent === "reject") {
          swipeRef.current = null;
          return;
        }
        swipe.vertical = true;
        setGestureActive(true);
        // 从收尾到达的精确像素接管，过渡中途抓住条带从那里继续而不是跳变。
        cancelSettle();
        swipe.startOffset = offsetRef.current;
        const el = trackRef.current;
        // 只有确认纵向后才提升层。
        if (el) el.style.willChange = "transform";
        // 指针捕获是增强而不是前提：`touchAction: pan-x` 已经把纵向移动交给我们，
        // 捕获只是让手指滑出元素后仍然收到事件。它会在指针已经结束时抛
        // NotFoundError（Android WebView 上真实发生过），不接住的话这一帧剩下的
        // 采样重置、偏移写入与 preventDefault 全部被跳过。
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // 没有捕获也能继续：事件仍然到达这个元素，只是滑出边界后可能中断。
        }
        // 从锁定点重启采样：锁定前的样本描述的是还没被认作换片的手势。
        swipe.samples = [];
      }

      swipe.samples.push({ y: event.clientY, time: performance.now() });
      if (swipe.samples.length > 8) swipe.samples.shift();
      writeOffset(
        swipe.startOffset +
          shortsSwipeDragOffset(swipe.index, swipe.length, deltaY, swipe.stageHeight),
      );
      // 阻止子元素把这当作滚动或拖拽。
      event.preventDefault();
      event.stopPropagation();
    },
    [cancelSettle, writeOffset],
  );

  const finishSwipe = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      swipeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!swipe.vertical) return;
      setGestureActive(false);

      if (cancelled) {
        const target = shortsTrackOffset(swipe.index, swipe.stageHeight);
        settle(target, shortsSwipeSettleDuration(target - offsetRef.current, 0));
        return;
      }

      swipe.samples.push({ y: event.clientY, time: performance.now() });
      const velocity = shortsSwipeVelocity(swipe.samples, SHORTS_SWIPE_VELOCITY_WINDOW_MS);
      const dragOffset = offsetRef.current - swipe.startOffset;
      const next = shortsSwipeTargetIndex(
        swipe.index,
        swipe.length,
        dragOffset,
        velocity,
        swipe.stageHeight,
      );
      event.preventDefault();
      event.stopPropagation();
      if (next === null) {
        const target = shortsTrackOffset(swipe.index, swipe.stageHeight);
        settle(target, shortsSwipeSettleDuration(target - offsetRef.current, velocity));
        return;
      }
      // 先开始收尾再通知 React：换片的提交（拆旧播放器、建新播放器）不该插在
      // 手指抬起与第一个动画帧之间。
      const target = shortsTrackOffset(next, swipe.stageHeight);
      settle(target, shortsSwipeSettleDuration(target - offsetRef.current, velocity));
      setIndex(next);
    },
    [settle],
  );

  const onPointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => finishSwipe(event, false),
    [finishSwipe],
  );
  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => finishSwipe(event, true),
    [finishSwipe],
  );

  /* ---------- 桌面：滚轮与键盘 ---------- */

  const wheelLockRef = useRef(0);
  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (Math.abs(event.deltaY) < 4) return;
      const now = performance.now();
      // 惯性滚轮一次手势会发几十个事件，一次只走一条。
      if (now < wheelLockRef.current) return;
      wheelLockRef.current = now + 420;
      goToIndex(index + (event.deltaY > 0 ? 1 : -1));
    },
    [goToIndex, index],
  );

  /**
   * 换片方向键与播放暂停热键。
   *
   * 抽屉打开时全部让路：评论列表与详情都是滚动容器，方向键和空格是它们的翻页。
   * `panels.anyOpen` 因此是这一整段的前置条件，而不是逐个键判断。
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || panels.anyOpen) return;
      const target = event.target;
      // 输入态（弹幕输入框等）、按钮与浮层不劫持这些键。
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, button, [contenteditable="true"], [data-slot="drawer-content"], [data-slot="shorts-seek"]',
        )
      ) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        goToIndex(index + 1);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        goToIndex(index - 1);
      } else if (event.key === " " || event.key === "k" || event.key === "K") {
        event.preventDefault();
        playback.togglePlay();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goToIndex, index, panels.anyOpen, playback]);

  const goBack = useCallback(() => {
    if (hasBrowserHistoryEntry(window.history.state)) navigate(-1);
    else navigate("/", { replace: true });
  }, [navigate]);

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
   * 这一页每秒随播放进度重渲染数次（`currentTime` 住在这里）。评论区是可能上百
   * 个节点的长列表，详情抽屉要发一次稿件请求 —— 两者都只跟条目身份有关，不该
   * 跟着进度重建。
   */
  const commentsBody = useMemo(
    () => (panels.aid ? <CommentsPanel key={panels.aid} aid={panels.aid} /> : null),
    [panels.aid],
  );
  const detailBody = useMemo(
    () =>
      current ? (
        <ShortsDetailBody
          key={current.bvid}
          item={current}
          open={panels.detailOpen}
          onOpenInPlayer={openInPlayer}
        />
      ) : null,
    [current, openInPlayer, panels.detailOpen],
  );

  /* ---------- 渲染 ---------- */

  if (feedQuery.isPending) {
    return <PlayerStageLoading onBack={goBack} label="正在加载短视频…" />;
  }

  if (feedQuery.isError && items.length === 0) {
    return (
      <div className="relative flex h-full min-h-0 flex-col items-center justify-center bg-black px-6">
        <ShortsBackButton onClick={goBack} />
        <ErrorState
          error={feedQuery.error}
          title="短视频加载失败"
          onRetry={() => void feedQuery.refetch()}
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
          <Button variant="outline" onClick={() => void feedQuery.refetch()}>
            重新加载
          </Button>
        </Empty>
      </div>
    );
  }

  const mounted = shortsMountedIndexes(index, items.length);

  return (
    <>
      <div
        ref={viewportRef}
        data-slot="shorts-viewport"
        // `media-skin` 提供 `--media-*` 令牌（白字 + 白色半透明悬停底）。复用播放器
        // HUD 的溢出菜单需要它：那些控件的配色走令牌，不在这个作用域里会落到应用
        // 前景色 —— 在黑舞台上变成看不见的深色图标。
        className="media-skin relative h-full min-h-0 overflow-hidden bg-black"
        style={
          {
            // 纵向手势由本页接管，横向留给系统返回手势。
            touchAction: "pan-x",
            /*
             * 媒体控件的尺寸基准。
             *
             * `.media-skin` 只给 `--media-scale-unit` 留了 16px 的兜底，算出来的控件是
             * 36px —— 而这一页其他按钮都是 44px（触摸目标），同一条顶栏里两种尺寸并排
             * 很显眼。1.2rem 让 `--media-control-size` 落到 43.2px，与它们齐平。
             *
             * 改这个变量而不是给按钮硬写尺寸：它就是这套令牌提供的缩放入口（播放器皮肤
             * 设 0.9rem，窄容器里降到 0.78rem），硬写会同时绕过圆角与图标的换算。
             */
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
          {mounted.map((itemIndex) => {
            const item = items[itemIndex];
            if (!item) return null;
            const active = itemIndex === index;
            return (
              <div
                key={shortsItemKey(item)}
                data-slot="shorts-panel"
                aria-hidden={active ? undefined : true}
                inert={active ? undefined : true}
                className="absolute inset-x-0 h-full"
                // 条目按绝对下标定位，换片不移动其中任何一个：收尾只动 track。
                style={{ top: `${itemIndex * 100}%` }}
              >
                {active ? (
                  <ShortsStage
                    item={item}
                    playback={playback}
                    videoRef={videoRef}
                    danmaku={danmaku}
                    danmakuVisible={danmakuVisible}
                    gestureActive={gestureActive}
                  />
                ) : (
                  <ShortsPoster item={item} />
                )}
              </div>
            );
          })}
        </div>

        {/* 顶部控制栏：返回 + 更多操作。固定在视口上，不随条带平移。 */}
        <div
          data-slot="shorts-top-bar"
          className="absolute inset-x-0 top-0 z-20 flex items-center gap-1.5 px-2"
          style={{
            height: `calc(${SHORTS_TOP_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_TOP})`,
            paddingTop: SHORTS_SAFE_AREA_TOP,
          }}
        >
          <ShortsBackButton onClick={goBack} inline />
          <span className="ml-auto">
            <ShortsMoreMenu
              compact={compact}
              muted={playback.muted}
              onToggleMuted={playback.toggleMuted}
              onOpenInPlayer={current ? openInPlayer : undefined}
              onRefresh={playback.retry}
            />
          </span>
        </div>

        {/* 桌面换片按钮：没有触摸时上下滑动无从进行，滚轮之外给一对显式入口。 */}
        <div className="absolute right-3 bottom-1/2 z-20 hidden translate-y-1/2 flex-col gap-2 md:flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="上一条"
            title="上一条（↑）"
            disabled={index === 0}
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
            disabled={index >= items.length - 1 && !feedQuery.hasNextPage}
            className="size-10 rounded-full bg-black/40 text-white/90 hover:bg-white/20 hover:text-white disabled:opacity-30"
            onClick={() => goToIndex(index + 1)}
          >
            <ChevronDown aria-hidden />
          </Button>
        </div>

        {/*
          信息与评论：浮在画面上、紧贴进度条上方，属于**页面层**而不是舞台层。

          这是与上一版的关键区别：它们以前长在画面框里（左下角与右侧操作栏），会随换片的
          条带平移一起滑走，而且每个面板各有一份（相邻封面也得自带一份）。挂在页面层之后
          只有一份，位置固定在视口上，与两条控制栏、进度条共用同一套坐标。

          浮层而不占真实空间：它压在画面底部（裁切铺满后那是真画面像素），因此要自带渐变
          垫底 —— 不然亮底画面上的白字不可读。容器不接指针（只评论按钮接），否则会在画面
          底部挖出一块点不动的区域（那里应该能点按暂停）。
        */}
        <div
          data-slot="shorts-info-float"
          // `px-2` 与底栏控制行一致（不是 `px-3`）：浮层里的评论按钮与控制行里那几个
          // 按钮同属右侧一条线，差 4px 就会看出错位。
          className="pointer-events-none absolute inset-x-0 z-20 flex items-end gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pt-8 pb-2"
          style={{ bottom: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})` }}
        >
          {/* 内容与控制行同宽同居中：桌面上两者必须对齐，否则信息在最左、输入框在中间。 */}
          <div className="mx-auto flex w-full max-w-lg items-end gap-2">
            {infoVisible && current && (
              <div className="flex min-w-0 flex-1 items-end gap-2">
                {/*
                  头像从右侧操作栏搬到这里。

                  评论按钮离开右侧栏之后那根栏只剩一个不可点的头像 —— 一根只有装饰的
                  操作栏不如不要。放在 UP 主名前也更符合它本来的语义：这是这条的作者。
                */}
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
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">
                    @{current.author || "未知 UP 主"}
                  </p>
                  <p className="line-clamp-2 text-sm text-white/90">{current.title}</p>
                  <p className="text-xs text-white/70">
                    {formatOnline(current.view)} 次播放
                    {playback.duration > 0 || current.duration > 0
                      ? ` · ${formatVideoDuration(playback.duration || current.duration)}`
                      : ""}
                  </p>
                </div>
              </div>
            )}
            {/* 信息隐藏时评论按钮仍留在右侧：它不是信息，是入口。 */}
            {!infoVisible && <span className="flex-1" />}
            {current && (
              <span className="pointer-events-auto flex shrink-0 flex-col items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={
                    current.danmaku > 0
                      ? `评论与弹幕，弹幕 ${formatOnline(current.danmaku)} 条`
                      : "评论"
                  }
                  title="评论"
                  className="size-11 text-white/90 hover:bg-white/15 hover:text-white"
                  onClick={panels.openComments}
                >
                  <MessageCircle className="size-6" aria-hidden />
                </Button>
                {current.danmaku > 0 && (
                  <span className="text-[11px] text-white/80">{formatOnline(current.danmaku)}</span>
                )}
              </span>
            )}
          </div>
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
        <div
          data-slot="shorts-bottom-bar"
          className="absolute inset-x-0 bottom-0 z-20 flex flex-col bg-black/85"
          style={{
            height: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
            paddingBottom: SHORTS_SAFE_AREA_BOTTOM,
          }}
        >
          <ShortsSeekBar
            bvid={current?.bvid ?? ""}
            cid={current?.cid ?? 0}
            currentTime={playback.currentTime}
            duration={playback.duration}
            onSeek={playback.seek}
          />
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
            <div className="mx-auto flex w-full max-w-lg items-center gap-1.5">
              <div className="min-w-0 flex-1">
                {current && (
                  <DanmakuComposer
                    overlay
                    roomTitle={current.title}
                    video={{
                      cid: current.cid ?? 0,
                      aid: current.aid,
                      progressMs: Math.floor(playback.currentTime * 1000),
                    }}
                  />
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={danmakuVisible ? "关闭弹幕" : "开启弹幕"}
                title={danmakuVisible ? "关闭弹幕" : "开启弹幕"}
                className="size-10 shrink-0 text-white/90 hover:bg-white/15 hover:text-white"
                onClick={() => setDanmakuVisible((value) => !value)}
              >
                {danmakuVisible ? <MessageSquare aria-hidden /> : <MessageSquareOff aria-hidden />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={infoVisible ? "隐藏视频信息" : "显示视频信息"}
                title={infoVisible ? "隐藏视频信息" : "显示视频信息"}
                aria-pressed={infoVisible}
                className="size-10 shrink-0 text-white/90 hover:bg-white/15 hover:text-white"
                onClick={() => setInfoVisible((value) => !value)}
              >
                <Info aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="视频详情"
                title="视频详情（简介、标签、UP 主）"
                disabled={!current}
                className="size-10 shrink-0 text-white/90 hover:bg-white/15 hover:text-white"
                onClick={panels.openDetail}
              >
                <ScrollText aria-hidden />
              </Button>
            </div>
          </div>
        </div>
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
    </>
  );
}

/**
 * 抽屉外壳。
 *
 * 手机从底部弹出、桌面从右侧滑入：竖屏上右侧抽屉只能占屏宽的一部分，评论正文
 * 被压成两三个字一行；而桌面上底部抽屉会把画面从下方顶掉一大块。侧别按视口
 * 决定，不按内容决定。
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
  return (
    <DrawerContent
      side={compact ? "bottom" : "right"}
      className={cn(
        "flex flex-col overflow-hidden p-0",
        compact
          ? "h-[70dvh] max-h-[70dvh]"
          : // 与直播页侧栏同宽（`PlayerPane` 的 `w-[min(22rem,78vw)]`）：同一套评论区
            // 在两个表面之间换个地方出现，宽度不该变。基础组件的 `right` 变体是
            // 20rem/60vw，这里显式覆盖（`cn` 走 twMerge，后者胜出）。
            "h-full w-[min(22rem,78vw)]",
      )}
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
function ShortsDetailBody({
  item,
  open,
  onOpenInPlayer,
}: {
  item: VideoItemForDetail;
  open: boolean;
  onOpenInPlayer: () => void;
}) {
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

      <Button variant="outline" className="w-full" onClick={onOpenInPlayer}>
        <ExternalLink aria-hidden />
        在播放页打开
      </Button>
    </div>
  );
}

/** 详情正文只用到这几个字段，收窄类型让它与 story 条目解耦。 */
type VideoItemForDetail = {
  bvid: string;
  title: string;
  author: string;
  author_face: string | null;
  view: number;
  danmaku: number;
  pubdate: number;
};

/**
 * 顶部「更多操作」菜单：静音、在播放页打开、刷新。
 *
 * 这三项都不该常驻画面：静音是一次性设定（不是每条都要调），播放页跳转是离开
 * 这个消费模式的出口，刷新只在取流失败时才有意义。竖屏画面上的每个常驻按钮都
 * 在挡内容，能收进菜单的就收。
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
  onOpenInPlayer,
  onRefresh,
}: {
  compact: boolean;
  muted: boolean;
  onToggleMuted: () => void;
  onOpenInPlayer?: (() => void) | undefined;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
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
      {/* 三列而不是播放页的四列：这里只有三项，四列会空出一格。 */}
      <div className="grid grid-cols-3 gap-1.5 max-md:gap-2">
        <PlayerToolTile
          icon={muted ? VolumeX : Volume2}
          label={muted ? "取消静音" : "静音"}
          pressed={muted}
          onClick={runAndClose(onToggleMuted)}
        />
        <PlayerToolTile
          icon={ExternalLink}
          label="在播放页打开"
          disabled={!onOpenInPlayer}
          onClick={runAndClose(() => onOpenInPlayer?.())}
        />
        <PlayerToolTile icon={RefreshCw} label="重新加载" onClick={runAndClose(onRefresh)} />
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

function ShortsBackButton({ onClick, inline }: { onClick: () => void; inline?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="返回上一页"
      title="返回上一页"
      // 黑舞台上不在播放器皮肤内，`--media-*` 令牌会落到应用前景色，
      // 图标必须自带白字与白色悬停底（与 PlayerStageLoading 同一画法）。
      className={
        inline
          ? "size-11 shrink-0 text-white/90 hover:bg-white/15 hover:text-white"
          : "absolute top-3 left-3 z-10 size-11 text-white/90 hover:bg-white/15 hover:text-white"
      }
      onClick={onClick}
    >
      <ChevronLeft aria-hidden />
    </Button>
  );
}
