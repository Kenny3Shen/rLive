import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  FastForward,
  Info,
  MessageCircle,
  MessageSquareOff,
  MessageSquareText,
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
import { useNavigate, useSearchParams } from "react-router-dom";
import { DanmakuComposer } from "@/features/room/BilibiliDanmakuComposer";
import { CommentsPanel } from "@/features/video/CommentsPanel";
import { videoGetArchive } from "@/features/video/videoApi";
import { formatRelativeTime, formatVideoDuration } from "@/features/video/videoHistory";
import { videoPlayPath } from "@/features/video/videoRoute";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/shared/components/ErrorState";
import { PlayerStageLoading } from "@/shared/components/player/PlayerStageLoading";
import { PlayerHudOverflowMenu, PlayerToolTile } from "@/shared/components/player/PlayerHudMenu";
import {
  danmakuControlPresentation,
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { panelDrawerSide, panelDrawerSizeClass } from "@/shared/components/player/panelDrawer";
import {
  hasLongPressMovedBeyondSlop,
  LONG_PRESS_SPEED_RATE,
  LONG_PRESS_TRIGGER_MS,
} from "@/shared/gestures/longPress";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { useCoarsePointer } from "@/shared/hooks/useCoarsePointer";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import { ANDROID_BACK_EVENT, DISMISSIBLE_POPUP_SELECTOR, hasBrowserHistoryEntry } from "@/app/androidBackNavigation";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import { ShortsSeekBar } from "./ShortsSeekBar";
import { ShortsSeekBridge, ShortsSeekPlayer } from "./shortsSeekPlayer";
import { ShortsPoster, ShortsStage } from "./ShortsStage";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_BOTTOM_CONTROLS_HEIGHT_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SEEK_BAR_HIT_OVERHANG_PX,
  SHORTS_SEED_PARAM,
  SHORTS_SLOT_IDS,
  SHORTS_SWIPE_SETTLE_EASING,
  SHORTS_SWIPE_VELOCITY_WINDOW_MS,
  SHORTS_TOP_BAR_HEIGHT_PX,
  shortsItemKey,
  shortsMountedIndexes,
  shortsPanelDepth,
  shortsSlotCoveredIndexes,
  shortsSlotTop,
  shortsSwipeDragOffset,
  shortsSwipeIntent,
  shortsSwipeSettleDuration,
  shortsSwipeTargetIndex,
  shortsSwipeVelocity,
  shortsTrackOffset,
  type ShortsSlotId,
  type ShortsSwipeSample,
} from "./shortsFeed";
import { useShortsStoryboard } from "./shortsStoryboard";
import { useShortsDanmaku } from "./useShortsDanmaku";
import { useShortsStableSlots } from "./useShortsStableSlots";
import { useShortsFeed } from "./useShortsFeed";
import { useShortsSessionRetention } from "./useShortsSessionRetention";

/**
 * 长按倍速释放后封锁点按的时长（ms）。
 *
 * 与播放页的 `SURFACE_TAP_SUPPRESSION_MS` 同量级：抬手后到达的延迟 click 必须落在这段里
 * 被否决，否则每次倍速松手都会顺手把视频暂停。
 */
const SHORTS_TAP_SUPPRESSION_MS = 300;

/**
 * 顶部按钮的尺寸基准。
 *
 * 取 40px，触摸设备抬到 44px —— 与底部操作栏那颗按钮（`size-10` 加基础组件的
 * `[@media(pointer:coarse)]:min-h-11`）以及它左边的弹幕输入框完全同高。
 *
 * 播放页与直播页也是这个做法：顶栏 HUD 与底栏控件共用同一套尺寸，一条画面上不会
 * 出现「上面比下面大一圈」。只收窄 `--media-control-size`，不动 `--media-scale-unit`
 * （进度条与它的悬停预览挂在那个变量上）。
 */
const SHORTS_TOP_CONTROLS_CLASS =
  "media-skin [--media-control-size:2.5rem] [@media(pointer:coarse)]:[--media-control-size:2.75rem]";

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
 *
 * ## 双播放器槽位
 *
 * 两个面板按槽位挂载（key 恒定 `slot-a` / `slot-b`），换片只改变它们各自持有哪
 * 一条与谁在播。被提升为活动的那个槽位已经预热好，因此换片不重新取流、不重建
 * 播放器（见 `useShortsSlots`）。
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
  const [gestureActive, setGestureActive] = useState(false);
  /** 进度条是否被交互过：悬停或按下一次后就去取快照。 */
  const [seekArmed, setSeekArmed] = useState(false);
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
   * `seekArmed` 一旦为真不再回落 —— 同一条视频里第二次交互应该立刻有图。
   */
  const { thumbnails } = useShortsStoryboard({
    bvid: current?.bvid ?? "",
    cid: current?.cid ?? 0,
    enabled: seekArmed,
  });
  const armSeek = useCallback(() => setSeekArmed(true), []);

  /* ---------- 播放、弹幕与抽屉 ---------- */

  const danmaku = useShortsDanmaku(current?.cid ?? 0, danmakuVisible);
  // 保留刚看过的那条的取流会话：方向翻转的第一次必然未命中预热（新目标既不在
  // 活动槽位也不在预热槽位），那一次实测要付 386~481ms 的取流。
  const retention = useShortsSessionRetention();
  const { slots, slotStates, playback, noteDirection } = useShortsStableSlots({
    items,
    index,
    refs: slotRefs,
    onProgress: danmaku.ensure,
    retention,
  });
  const panels = useShortsPanels(current);

  /* ---------- 长按倍速 ---------- */

  /**
   * 按住画面临时倍速，松手回 1x —— 与播放页同一套语义、同一组常量
   * （`LONG_PRESS_SPEED_RATE` / `LONG_PRESS_TRIGGER_MS`），因此两个表面上的手感一致。
   *
   * 挂在页面这条 pointer 管线里而不是另起一个识别器：换片手势会
   * `setPointerCapture` 并 `stopPropagation`，另挂一套的取消路径会失明（与卡片长按
   * 必须镜像到 window 捕获阶段是同一个原因）。位移容忍半径
   * （`LONG_PRESS_CANCEL_SLOP_PX`，10px）小于换片锁定距离
   * （`SHORTS_SWIPE_LOCK_DISTANCE_PX`，12px），因此能锁成换片的手势必定先取消倍速，
   * 不会出现「倍速中又换了片」。
   */
  const speedPressRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const speedHoldTimerRef = useRef<number | null>(null);
  const speedHoldActiveRef = useRef(false);
  /** 倍速释放后短暂封锁点按：抬手后可能补发一次 click，那一下不该切暂停。 */
  const suppressTapUntilRef = useRef(0);
  /**
   * 计时器到期时才读的资格。
   *
   * 不在按下时闭包捕获：按下与触发相隔 500ms，这段时间里取流可能刚好完成，也可能
   * 刚好失败。按下那一刻的判断到期时已经过时。
   */
  const speedEligibleRef = useRef(false);
  useLayoutEffect(() => {
    speedEligibleRef.current = !playback.loading && !playback.error && !playback.paused;
  }, [playback.error, playback.loading, playback.paused]);

  const setRate = playback.setRate;

  const releaseSpeedHold = useCallback(() => {
    if (speedHoldTimerRef.current !== null) {
      window.clearTimeout(speedHoldTimerRef.current);
      speedHoldTimerRef.current = null;
    }
    speedPressRef.current = null;
    if (!speedHoldActiveRef.current) return;
    speedHoldActiveRef.current = false;
    suppressTapUntilRef.current = Date.now() + SHORTS_TAP_SUPPRESSION_MS;
    setRate(1);
  }, [setRate]);

  const armSpeedHold = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      releaseSpeedHold();
      // 只认领画面框上的按压：框外是背景区与两条控制栏，按住它们不该改变播放速度
      // （点按暂停层也只铺画面框，两者的命中范围刻意一致）。
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[data-slot="shorts-frame"]')
      ) {
        return;
      }
      speedPressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      speedHoldTimerRef.current = window.setTimeout(() => {
        speedHoldTimerRef.current = null;
        if (!speedPressRef.current || !speedEligibleRef.current) return;
        speedHoldActiveRef.current = true;
        // 立即封锁点按：倍速期间手指仍在画面上，中途任何补发的 click 都不该切暂停。
        suppressTapUntilRef.current = Date.now() + SHORTS_TAP_SUPPRESSION_MS;
        setRate(LONG_PRESS_SPEED_RATE);
      }, LONG_PRESS_TRIGGER_MS);
    },
    [releaseSpeedHold, setRate],
  );

  /** 手指漂移出容忍半径即取消：那是一次滑动（换片或误触），不是长按。 */
  const trackSpeedHoldMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = speedPressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      if (hasLongPressMovedBeyondSlop(press.x, press.y, event.clientX, event.clientY)) {
        releaseSpeedHold();
      }
    },
    [releaseSpeedHold],
  );

  /**
   * 抬手一律在 window 捕获阶段收：指针可能在视口外结束（桌面把鼠标拖出窗口再松），
   * Android WebView 也有丢 `pointercancel` 的先例。漏一次就会把 3x 永久留在画面上，
   * 而界面上除了换片没有别的出口。
   */
  useEffect(() => {
    const onEnd = () => releaseSpeedHold();
    window.addEventListener("pointerup", onEnd, true);
    window.addEventListener("pointercancel", onEnd, true);
    return () => {
      window.removeEventListener("pointerup", onEnd, true);
      window.removeEventListener("pointercancel", onEnd, true);
      releaseSpeedHold();
    };
  }, [releaseSpeedHold]);

  /**
   * 画面点按：切播放/暂停。
   *
   * 决定权归页面而不是舞台：长按倍速的抬手会补发一次 click，只有这一层知道刚才那次
   * 按压已经被倍速认领了。
   */
  const onSurfaceTap = useCallback(() => {
    if (Date.now() < suppressTapUntilRef.current) return;
    playback.togglePlay();
  }, [playback]);

  /* ---------- 纵向翻页：手指按下期间直接写 transform，释放交给合成器 ---------- */

  const offsetRef = useRef(0);
  const animationRef = useRef<Animation | null>(null);
  /**
   * 收尾动画是否在跑。
   *
   * 换片提交时 `parkTrack` 会因 `index` 变化重跑；若它照常取消动画，就会把刚启动的
   * 收尾取消成一次硬切（正是「先瞬间切换、再滑一下」的根因）。它期间必须让位。
   */
  const settlingRef = useRef(false);
  const stageHeightRef = useRef(0);
  /**
   * 每个面板的纵深基准。
   *
   * 面板的 `top` 是绝对下标 × 舞台高，而条带在平移，因此「离视口中心多远」是
   * `offset + top`。拖动开始与每次停靠时重采：面板集合会随换片增减，高度会随旋转变化。
   */
  const depthPanelsRef = useRef<{ el: HTMLElement; top: number }[]>([]);
  const depthAnimationsRef = useRef<Animation[]>([]);
  /** 本手势内是否要跳过纵深（系统设置）。在采样时定下，不在每帧重读 matchMedia。 */
  const depthReducedRef = useRef(false);
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

  // 轴锁前尚未 capture 指针，抬手可能落在视口外；不能把分页接入门永久锁住。
  useEffect(() => {
    const finishPending = (event: PointerEvent) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId || swipe.vertical) return;
      swipeRef.current = null;
      if (!settlingRef.current) setFeedMotionActive(false);
    };
    window.addEventListener("pointerup", finishPending, true);
    window.addEventListener("pointercancel", finishPending, true);
    return () => {
      window.removeEventListener("pointerup", finishPending, true);
      window.removeEventListener("pointercancel", finishPending, true);
    };
  }, []);

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

  /** 重采面板的纵深基准（拖动锁定、停靠、尺寸变化时）。 */
  const collectDepthPanels = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    depthReducedRef.current = prefersReducedMotion();
    depthPanelsRef.current = Array.from(
      track.querySelectorAll<HTMLElement>('[data-slot="shorts-panel"]'),
    ).map((el) => ({ el, top: el.offsetTop }));
  }, []);

  /**
   * 把纵深写进每个面板的内联样式。
   *
   * 只碰 `transform` 与 `opacity`：拖动期间每个 pointermove 都会走这里，写成别的属性
   * 会拉着布局一起重算。系统开启「减弱动态效果」时不写任何缩放，构图保持原样。
   */
  /* oxlint-disable react/immutability */
  const writeDepth = useCallback(
    (offset: number) => {
      const height = stageHeight();
      if (!(height > 0)) return;
      const reduced = depthReducedRef.current;
      for (const panel of depthPanelsRef.current) {
        if (reduced) {
          panel.el.style.transform = "";
          panel.el.style.opacity = "";
          continue;
        }
        const depth = shortsPanelDepth(Math.abs(offset + panel.top) / height);
        // 恒等值用空字符串表达：静止时不给正在看的那条平白加一层 stacking context，
        // 也不会因 `scale(1)` 之外的写入让 React 的样式 diff 多一项。
        panel.el.style.transform = depth.scale === 1 ? "" : `scale(${depth.scale})`;
        panel.el.style.opacity = depth.opacity === 1 ? "" : String(depth.opacity);
      }
    },
    [stageHeight],
  );
  /* oxlint-enable react/immutability */

  /** 拖动中的每帧路径：条带平移与面板纵深一起写。 */
  const writePlacement = useCallback(
    (offset: number) => {
      writeOffset(offset);
      writeDepth(offset);
    },
    [writeDepth, writeOffset],
  );

  /** 在当前位置停止收尾，把该偏移留下作为内联样式。 */
  const cancelSettle = useCallback(() => {
    settlingRef.current = false;
    const depthAnimations = depthAnimationsRef.current;
    if (depthAnimations.length > 0) {
      depthAnimationsRef.current = [];
      // 不在中途提交纵深值：下一次 writeDepth / 手势会按同一 offset 重写，比取矩阵可靠。
      for (const animation of depthAnimations) animation.cancel();
    }
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
   * 纵深收尾动画。
   *
   * 按每个面板**自己的**距离分别补间，而不是把条带整体缩放：那样会让正在看的这条也跟
   * 着缩一下。面板集合按开始时的快照取值（`depthPanelsRef`），因为这条动画要跨过
   * `setIndex` 的那次提交 —— 提交只改 `top`，不动我们已经写在面板上的内联样式。
   *
   * 在 `settle` 之前声明：后者引用它。
   */
  const animateDepth = useCallback(
    (from: number, target: number, duration: number): Animation[] => {
      const height = stageHeight();
      // 注意：`reduced` 在采集时已定，若中途切换系统设置则这一步动画仍会起，但下一次
      // 停靠/拖动就会回到原样——比每帧重读 matchMedia 便宜。
      if (!(height > 0) || depthReducedRef.current) return [];
      const animations: Animation[] = [];
      for (const panel of depthPanelsRef.current) {
        const at = (offset: number) => shortsPanelDepth(Math.abs(offset + panel.top) / height);
        const start = at(from);
        const end = at(target);
        animations.push(
          panel.el.animate(
            [
              { transform: `scale(${start.scale})`, opacity: start.opacity },
              { transform: `scale(${end.scale})`, opacity: end.opacity },
            ],
            { duration, easing: SHORTS_SWIPE_SETTLE_EASING, fill: "both" },
          ),
        );
      }
      depthAnimationsRef.current = animations;
      return animations;
    },
    [stageHeight],
  );

  /**
   * 把剩余行程交给合成器。
   *
   * 刻意用 Web Animations 而不是 rAF 补间：换片会触发一次 React 提交（拆旧播放器、
   * 建新播放器），主线程上的补间会被那次提交吞掉大部分帧 —— 那正是「先瞬间切换、
   * 再滑一下」的观感来源。`fill: both` 让第一个关键帧立即生效，条带不会绘制出
   * 未变换的一帧。
   *
   * 面板纵深用等长同缓动的第二条动画一起跑：条带平移与缩放淡出必须同时到达，否则
   * 会看到画面先滑到位再「啪」地缩一下。
   */
  const settle = useCallback(
    (target: number, duration: number) => {
      const el = trackRef.current;
      if (!el) return;
      cancelSettle();
      // 面板集合与高度可能在上一轮换片/旋转后变了：收尾前重采一次，纵深动画才有正确的基准。
      collectDepthPanels();
      const from = offsetRef.current;
      if (duration <= 0 || from === target || prefersReducedMotion()) {
        settlingRef.current = false;
        setFeedMotionActive(false);
        offsetRef.current = target;
        el.style.transform = `translate3d(0, ${target}px, 0)`;
        el.style.willChange = "";
        // 瞬时路径没有动画，纵深必须直接落到位，否则会停在上一手势的中间值。
        writeDepth(target);
        return;
      }
      settlingRef.current = true;
      setFeedMotionActive(true);
      offsetRef.current = target;
      el.style.willChange = "transform";
      const animation = el.animate(
        [
          { transform: `translate3d(0, ${from}px, 0)` },
          { transform: `translate3d(0, ${target}px, 0)` },
        ],
        { duration, easing: SHORTS_SWIPE_SETTLE_EASING, fill: "both" },
      );
      animationRef.current = animation;
      const depthAnimations = animateDepth(from, target, duration);
      void animation.finished
        .then(() => {
          if (animationRef.current !== animation) return;
          animationRef.current = null;
          settlingRef.current = false;
          setFeedMotionActive(false);
          // 先写内联样式再取消动画：顺序颠倒会让部分 Android 合成器画出一帧未变换的层。
          el.style.transform = `translate3d(0, ${target}px, 0)`;
          animation.cancel();
          el.style.willChange = "";
        })
        .catch(() => {
          // 新手势或新下标打断时预期会取消。
        });
      void Promise.all(depthAnimations.map((item) => item.finished.catch(() => undefined))).then(
        () => {
          if (depthAnimationsRef.current !== depthAnimations) return;
          depthAnimationsRef.current = [];
          // 同样先写内联再取消，避免最后一帧回退成未缩放的构图。
          writeDepth(target);
          for (const item of depthAnimations) item.cancel();
        },
      );
    },
    [animateDepth, cancelSettle, collectDepthPanels, writeDepth],
  );

  /** 把条带停靠在当前下标处，不做运动（挂载、尺寸变化、下标被外部改动）。 */
  const parkTrack = useCallback(() => {
    if (swipeRef.current?.vertical) return;
    // 收尾进行中就让它跑到终点：这里取消动画会变成一次硬切（目标与收尾目标相同）。
    if (settlingRef.current) return;
    cancelSettle();
    const target = shortsTrackOffset(index, stageHeight());
    collectDepthPanels();
    writeOffset(target);
    writeDepth(target);
    const el = trackRef.current;
    if (el) el.style.willChange = "";
  }, [cancelSettle, collectDepthPanels, index, stageHeight, writeDepth, writeOffset]);

  useLayoutEffect(() => {
    parkTrack();
  }, [items, parkTrack]);

  // 视口高度变化（旋转、系统栏、软键盘）要重建纵向基准，否则第一条之后的
  // 条目会整个被推出屏幕。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    // 初值取当前高度，而不是 0：这条 effect 依赖 `index`，每次换片都会重建观察器，
    // 而观察器首次回调几乎必然带着「和现在一样」的高度。若从 0 起步，那次回调会被
    // 当成一次真实的高度变化，恰好落在刚启动的收尾上把它取消成硬切 —— 正是这个 bug
    // 的主因。取当前高度后，首次回调自然是无操作。
    let applied = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = viewport.clientHeight;
      // 只有高度变化才重建：手势与收尾进行中一律不动，避免把运行中的动画跳到终点。
      if (height <= 0 || height === applied || swipeRef.current?.vertical) return;
      if (settlingRef.current) return;
      applied = height;
      stageHeightRef.current = height;
      cancelSettle();
      collectDepthPanels();
      writeOffset(shortsTrackOffset(index, height));
      writeDepth(shortsTrackOffset(index, height));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [cancelSettle, collectDepthPanels, index, writeDepth, writeOffset]);

  useEffect(
    () => () => {
      const animation = animationRef.current;
      animationRef.current = null;
      animation?.cancel();
      for (const depthAnimation of depthAnimationsRef.current) depthAnimation.cancel();
      depthAnimationsRef.current = [];
    },
    [],
  );

  /**
   * 跳到某一条：已挂载的目的条先开始平移，再通知 React。
   *
   * 顺带记下滑动方向：预热槽位按它决定去预热哪一条邻居（`useShortsSlots`）。
   * 放在这里而不是页面别处，是因为所有换片入口（手势、滚轮、方向键、桌面按钮）
   * 都汇聚到这个函数 —— 方向因此不可能漏记。
   */
  const goToIndex = useCallback(
    (next: number, velocity = 0) => {
      if (feed.navigationLocked) return;
      if (next < 0 || next >= items.length) {
        if (feed.uploaderMode) void feed.load(next < 0 ? "prev" : "next");
        return;
      }
      if (next === index) return;
      noteDirection(index, next);
      const target = shortsTrackOffset(next, stageHeight());
      settle(target, shortsSwipeSettleDuration(target - offsetRef.current, velocity));
      setIndex(next);
    },
    [feed, index, items.length, noteDirection, setIndex, settle, stageHeight],
  );

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pointerType = event.pointerType as string;
      // 进度条上的按压归它自己：那是唯一的横向精细操作，纵向抖动不该换片。
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-slot="shorts-seek"]')
      ) {
        return;
      }
      // 长按倍速先于换片武装：它对鼠标也成立（桌面按住画面同样倍速），而下面那段换片
      // 只收手指。两者共用同一次按压：位移超过容忍半径时倍速自己取消（见
      // `trackSpeedHoldMove`），不需要在这里分他们的胜负。
      armSpeedHold(event);
      // 部分 Android WebView 对手指输入上报空的 pointerType。鼠标不参与换片
      // （桌面用滚轮与方向键，见下）。
      if ((pointerType !== "touch" && pointerType !== "") || !event.isPrimary || feed.navigationLocked) return;
      setFeedMotionActive(true);
      // 这是页面级换片手势的起点：面板此刻的纵深基准就是「用手势接管之前」的静态画像，
      // 必须在这里采。一旦开始拖动，`offsetTop` 会被条带平移影响（这里读到的仍是布局值，
      // 但集合本身会在换片提交时增减），所以基准就该在按下时定下。
      collectDepthPanels();
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
    [armSpeedHold, collectDepthPanels, feed.navigationLocked, index, items.length, stageHeight],
  );

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 先算倍速的取消：鼠标没有 `swipeRef`，下一行就返回了。
      trackSpeedHoldMove(event);
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - swipe.startX;
      const deltaY = event.clientY - swipe.startY;

      if (!swipe.vertical) {
        const intent = shortsSwipeIntent(deltaX, deltaY);
        if (intent === "pending") return;
        if (intent === "reject") {
          swipeRef.current = null;
          if (!settlingRef.current) setFeedMotionActive(false);
          return;
        }
        swipe.vertical = true;
        setGestureActive(true);
        // 从收尾到达的精确像素接管，过渡中途抓住条带从那里继续而不是跳变。
        cancelSettle();
        swipe.startOffset = offsetRef.current;
        const el = trackRef.current;
        // 只有确认纵向后才提升层；面板的纵深基准也在这一刻采一次（集合与高度都还新鲜）。
        if (el) el.style.willChange = "transform";
        collectDepthPanels();
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
      writePlacement(
        swipe.startOffset +
          shortsSwipeDragOffset(swipe.index, swipe.length, deltaY, swipe.stageHeight),
      );
      // 阻止子元素把这当作滚动或拖拽。
      event.preventDefault();
      event.stopPropagation();
    },
    [cancelSettle, collectDepthPanels, trackSpeedHoldMove, writePlacement],
  );

  const finishSwipe = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      swipeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!swipe.vertical) {
        if (!settlingRef.current) setFeedMotionActive(false);
        return;
      }
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
    [setIndex, settle],
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
   *
   * 上下键必须在**捕获阶段**抢先认领：进度条用的是 Video.js `TimeSlider`，它把
   * ↑/↓/PageUp/PageDown 也当 seek，而它的可聚焦元素是进度条里的 Thumb —— 用户碰过
   * 进度条后焦点就留在那里，冒泡阶段的监听（下面那个）已经先被它处理过了。捕获阶段
   * 先一步认领这四个键并阻止事件下传；←/→ 继续放行给进度条做 ±5s。
   */
  useEffect(() => {
    function onKeyDownCapture(event: KeyboardEvent) {
      if (event.defaultPrevented || panels.anyOpen) return;
      const target = event.target;
      // 输入态（弹幕输入框等）、按钮与浮层不劫持这些键。
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, button, [contenteditable="true"], [data-slot="drawer-content"]',
        )
      ) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        event.stopPropagation();
        goToIndex(index + 1);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        event.stopPropagation();
        goToIndex(index - 1);
      }
    }
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [goToIndex, index, panels.anyOpen]);

  /**
   * 播放暂停热键。
   *
   * 与换片方向键分开成两个监听：暂停键属于冒泡阶段（没有被原语抢），而方向键必须
   * 在捕获阶段先于进度条认领。
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
      if (event.key === " " || event.key === "k" || event.key === "K") {
        event.preventDefault();
        playback.togglePlay();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panels.anyOpen, playback]);

  const goBack = useCallback(() => {
    if (feed.uploaderMode) {
      releaseSpeedHold();
      swipeRef.current = null;
      cancelSettle();
      setGestureActive(false);
      setFeedMotionActive(false);
      feed.exitUploader();
      return;
    }
    if (hasBrowserHistoryEntry(window.history.state)) navigate(-1);
    else navigate("/", { replace: true });
  }, [cancelSettle, feed, navigate, releaseSpeedHold]);

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
   * 这一页每秒随播放进度重渲染数次（`currentTime` 住在这里）。评论区是可能上百
   * 个节点的长列表，详情抽屉要发一次稿件请求 —— 两者都只跟条目身份有关，不该
   * 跟着进度重建。
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
    return (
      <div className="relative h-full min-h-0">
        <ShortsBackButton onClick={goBack} />
        <PlayerStageLoading label="正在加载短视频…" />
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
  /** 挂载窗口里由槽位面板承担的下标；其余渲染封面占位。 */
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
            挂载窗口里剩下的位置（第三条邻居）渲染封面占位：它们只需要有画面参与
            平移，不需要能播 —— 一条短视频等于一次签名 playurl + 两条 sidx + 三个
            本机代理会话，为跟手再多起一份是把上游取流成本翻倍。
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
                <ShortsPoster item={item} />
              </div>
            );
          })}
        </div>

        {/*
          把活动槽位的 `<video>` 桥接进进度条的播放器 store。

          必须渲染在槽位面板**之外**：面板里还有一层 `ShortsPosterPlayer`（封面与
          状态指示用），渲染在它里面会被那个更近的 Player 上下文截走。也不属于条带，
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
        <div
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
        </div>

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
          而且每个面板各有一份（相邻封面也得自带一份）。挂在页面层之后只有一份，位置固定
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
            </div>

            {/* 评论贴右下角。跟信息一起显隐（外层已经判了 `infoVisible`）。 */}
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
                className="size-11 rounded-full text-white/90 hover:bg-white/15 hover:text-white"
                onClick={panels.openComments}
              >
                <MessageCircle className="size-6" aria-hidden />
              </Button>
              {current.danmaku > 0 && (
                <span className="text-[11px] text-white/80">{formatOnline(current.danmaku)}</span>
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
        <div
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
                      progressMs: Math.floor(playback.currentTime * 1000),
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

function ShortsBackButton({ onClick, inline, label = "返回上一页" }: { onClick: () => void; inline?: boolean; label?: string }) {
  return (
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
  );
}
