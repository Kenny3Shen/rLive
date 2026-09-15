import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ExternalLink,
  MessageSquareOff,
  MessageSquare,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { CommentsPanel } from "@/features/video/CommentsPanel";
import { videoGetStory } from "@/features/video/videoApi";
import { videoPlayPath } from "@/features/video/videoRoute";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { ErrorState } from "@/shared/components/ErrorState";
import { PlayerStageLoading } from "@/shared/components/player/PlayerStageLoading";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { prefersReducedMotion, SWIPE_SETTLE_EASING } from "@/shared/motion/tokens";
import { hasBrowserHistoryEntry } from "@/app/androidBackNavigation";
import { ShortsPoster, ShortsStage, useShortsComments } from "./ShortsStage";
import {
  SHORTS_SWIPE_VELOCITY_WINDOW_MS,
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

/**
 * `/shorts`：B 站短视频（story feed）的竖屏消费页。
 *
 * 沉浸式路由（无侧栏、无顶栏，见 `immersiveRoutes`），返回口是画面内 HUD 的
 * 悬浮箭头，与其他沉浸播放页同一位置同一画法。
 *
 * 上游是**无游标轮换流**：没有页码也没有总数，「加载更多」= 再拉一批并跨页去重，
 * 因此这一页永远不知道自己有多长。最后一条上的越界阻尼是「暂时到底」的反馈，
 * 不是终点声明；剩余不足 `SHORTS_PREFETCH_REMAINING` 条就提前补货。
 */
export function ShortsPage() {
  const navigate = useNavigate();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [rawIndex, setIndex] = useState(0);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [gestureActive, setGestureActive] = useState(false);

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
  const comments = useShortsComments(current);

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
        event.currentTarget.setPointerCapture(event.pointerId);
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

  /* ---------- 桌面：滚轮与方向键 ---------- */

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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || comments.open) return;
      const target = event.target;
      // 输入态（评论抽屉里的输入框等）不劫持方向键。
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        goToIndex(index + 1);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        goToIndex(index - 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [comments.open, goToIndex, index]);

  const goBack = useCallback(() => {
    if (hasBrowserHistoryEntry(window.history.state)) navigate(-1);
    else navigate("/", { replace: true });
  }, [navigate]);

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
    <div
      ref={viewportRef}
      data-slot="shorts-viewport"
      className="relative h-full min-h-0 overflow-hidden bg-black"
      // 纵向手势由本页接管，横向留给系统返回手势。
      style={{ touchAction: "pan-x" }}
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
                  danmakuVisible={danmakuVisible}
                  gestureActive={gestureActive}
                  onOpenComments={comments.openComments}
                />
              ) : (
                <ShortsPoster item={item} />
              )}
            </div>
          );
        })}
      </div>

      {/* 顶部 HUD：返回、弹幕开关、跳播放页。 */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-1.5 px-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <ShortsBackButton onClick={goBack} inline />
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={danmakuVisible ? "关闭弹幕" : "开启弹幕"}
            title={danmakuVisible ? "关闭弹幕" : "开启弹幕"}
            className="size-11 text-white/90 hover:bg-white/15 hover:text-white"
            onClick={() => setDanmakuVisible((value) => !value)}
          >
            {danmakuVisible ? <MessageSquare aria-hidden /> : <MessageSquareOff aria-hidden />}
          </Button>
          {current && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="在播放页打开"
              title="在播放页打开（可拖进度、切清晰度、发弹幕）"
              className="size-11 text-white/90 hover:bg-white/15 hover:text-white"
              onClick={() =>
                navigate(
                  videoPlayPath({
                    bvid: current.bvid,
                    cid: current.cid ?? 0,
                    epId: null,
                    title: current.title,
                    aid: current.aid,
                  }),
                )
              }
            >
              <ExternalLink aria-hidden />
            </Button>
          )}
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

      <Drawer open={comments.open} onOpenChange={comments.setOpen}>
        <DrawerContent side="right" className="flex h-full flex-col overflow-hidden p-0">
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
            <DrawerTitle>评论</DrawerTitle>
          </div>
          {/* CommentsPanel 不自带滚动容器，由这里提供。 */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {comments.aid && <CommentsPanel key={comments.aid} aid={comments.aid} />}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
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
