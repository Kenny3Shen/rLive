import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Ban, Copy, MessageSquarePlus, Star } from "lucide-react";
import type { DanmakuEvent, SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  createBlockedUserMatcher,
  createShieldMatcher,
  shouldShowValidatedInDanmakuPanel,
} from "./danmaku/filter";
import { DanmakuRichText } from "./danmaku/emoji";
import { subscribeDanmakuBatches } from "./danmaku/eventBus";
import { BoundedQueue } from "./danmaku/boundedQueue";
import {
  appendWithinDanmakuListWindow,
  danmakuListAppendCapacity,
  DANMAKU_LIST_MAX_PINNED,
  DANMAKU_LIST_MAX_SCROLLED_UP,
  scrollTopAfterDanmakuListTrim,
  trimToDanmakuListWindow,
} from "./danmaku/listWindow";
import {
  danmakuListSurfaceFromTheme,
  resolveDanmakuListUserColor,
  type DanmakuListSurface,
} from "./danmaku/listColor";
import { formatDanmakuClipboardText, useDanmakuActions } from "./danmaku/useDanmakuActions";
import { cn } from "@/lib/utils";

// 即使房间每分钟产生上千条评论，也把渲染的 DOM 保持得很小。有界队列保留近期
// 流量，而不要求 React 维护无限增长的聊天树。渲染窗口本身取决于钉住状态；
// 参见 `listWindow.ts`。
const MAX_BUFFERED = 200;
const MAX_PER_FLUSH = 32;
const MIN_FLUSH_INTERVAL_MS = 32;
const BACKPRESSURE_FLUSH_INTERVAL_MS = 80;
const BACKPRESSURE_PENDING_THRESHOLD = MAX_PER_FLUSH * 2;
const SCROLL_VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

function scrollDanmakuViewportToBottom(root: HTMLElement | null): void {
  const viewport = root?.querySelector<HTMLElement>(SCROLL_VIEWPORT_SELECTOR);
  if (!viewport) return;
  const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  // 即使在已钉住时赋值 `scrollTop` 也可能在原语内派发额外的滚动工作。
  // 避免在每次批量 React 提交上都做这次同步写入。
  if (Math.abs(viewport.scrollTop - target) > 1) viewport.scrollTop = target;
}

type DanmakuLine = { id: number; event: DanmakuEvent };

function DanmakuSender({
  event,
  user,
  surface,
}: {
  event: DanmakuEvent;
  user: string;
  surface: DanmakuListSurface;
}) {
  // 平台色面向视频叠加层。在浅色列表表面上常见的白色默认值没有对比度，
  // 因此回退到 `text-primary`。
  const userColor = resolveDanmakuListUserColor(event.color, surface);

  return (
    <>
      <span className="mr-1.5 text-primary" style={userColor ? { color: userColor } : undefined}>
        {user}：
      </span>
    </>
  );
}

/**
 * 追加批次会保持既有 `DanmakuLine` 引用不变。因此记忆化一行可以避免繁忙房间
 * 里每次动画帧冲刷都重新协调最多 300 条已渲染消息。
 */
const DanmakuRow = memo(function DanmakuRow({
  line,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  surface,
}: {
  line: DanmakuLine;
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  surface: DanmakuListSurface;
}) {
  const { event } = line;
  if (event.kind === "system") {
    return (
      <div className="px-1.5 py-0.5 text-xs text-muted-foreground">
        <DanmakuRichText content={event.content} spans={event.spans} />
      </div>
    );
  }

  return (
    <SelectableDanmakuRow
      event={event}
      siteId={siteId}
      roomId={roomId}
      roomTitle={roomTitle}
      roomUserName={roomUserName}
      surface={surface}
    />
  );
});

/**
 * 这个状态刻意放在记忆化列表行之下。打开一个操作菜单
 * 绝不会使高频父列表或其余 299 条已渲染消息失效。
 */
const SelectableDanmakuRow = memo(function SelectableDanmakuRow({
  event,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  surface,
}: {
  event: DanmakuEvent;
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  surface: DanmakuListSurface;
}) {
  const [open, setOpen] = useState(false);
  const message = formatDanmakuClipboardText(event.content);
  const user = event.user.trim() || "匿名";
  const actions = useDanmakuActions({
    message,
    eventKind: event.kind,
    user: event.user,
    siteId,
    roomId,
    roomTitle,
    roomUserName,
  });

  if (!message) {
    return (
      <div
        className={cn(
          "rounded-md border border-transparent px-1.5 py-1 leading-relaxed font-semibold",
          event.is_self === true && "border-primary/60",
        )}
      >
        <DanmakuSender event={event} user={user} surface={surface} />
        <DanmakuRichText content={event.content} spans={event.spans} />
      </div>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) actions.resetStatus();
      }}
    >
      <PopoverTrigger
        type="button"
        aria-label={`选择 ${user} 的弹幕`}
        className={cn(
          "block w-full cursor-pointer appearance-none rounded-md border border-transparent bg-transparent px-1.5 py-1 text-left leading-relaxed font-semibold text-foreground outline-none transition-colors hover:bg-muted/50 aria-expanded:bg-muted",
          event.is_self === true && "border-primary/60",
        )}
      >
        <DanmakuSender event={event} user={user} surface={surface} />
        <DanmakuRichText content={event.content} spans={event.spans} />
      </PopoverTrigger>
      <PopoverContent side="left" align="start" className="w-40 p-1">
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            title="复制弹幕"
            onClick={() => void actions.copy()}
          >
            <Copy data-icon="inline-start" aria-hidden />
            复制
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            disabled={!actions.canFavorite || actions.favoriting}
            title={actions.favoriteLabel}
            onClick={() => void actions.favorite()}
          >
            {actions.favoriting ? (
              <Spinner data-icon="inline-start" aria-hidden />
            ) : (
              <Star data-icon="inline-start" aria-hidden />
            )}
            收藏
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            disabled={!actions.canRepeat || actions.sending}
            aria-label={actions.repeatLabel}
            title={actions.repeatLabel}
            onClick={() => void actions.repeat()}
          >
            <MessageSquarePlus data-icon="inline-start" aria-hidden />
            +1
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start text-destructive"
            disabled={!actions.canBlock}
            aria-label={actions.blockLabel}
            title={actions.blockLabel}
            onClick={() => {
              actions.block();
              setOpen(false);
            }}
          >
            <Ban data-icon="inline-start" aria-hidden />
            屏蔽
          </Button>
        </div>
        {actions.statusMessage && (
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "px-1 py-1 text-center text-xs leading-snug",
              actions.failed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {actions.statusMessage}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
});

type DanmakuPanelProps = {
  active: boolean;
  /** Current room identity used only by the explicit “+1” send action. */
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  /** 另一个房间侧页签打开时继续收集，但不重绘该面板。 */
  visible?: boolean;
  className?: string;
  statusText?: string | null;
};

export const DanmakuPanel = memo(function DanmakuPanel({
  active,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  visible = true,
  className,
  statusText,
}: DanmakuPanelProps) {
  const [items, setItems] = useState<readonly DanmakuLine[]>([]);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const unreadCountRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const pendingRef = useRef(new BoundedQueue<DanmakuLine>(MAX_BUFFERED));
  // 一次向上滚动裁剪被提交时设置，其布局落定后消费一次。
  const pendingTrimRef = useRef<{ viewport: HTMLElement; heightBeforeTrim: number } | null>(null);
  const flushFrameRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const lastFlushAtRef = useRef(0);
  const scheduleFlushRef = useRef<() => void>(() => {});
  const nextIdRef = useRef(0);
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  const theme = useSettingsStore((s) => s.theme);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const filterGifts = useSettingsStore((s) => s.danmakuFilterGifts);
  const blockedUsers = useSettingsStore((s) => s.danmakuBlockedUsers);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
  const blockedUserMatcher = useMemo(() => createBlockedUserMatcher(blockedUsers), [blockedUsers]);
  const matchersRef = useRef({ shieldMatcher, blockedUserMatcher, filterGifts });
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false,
  );
  const listSurface = useMemo(
    () => danmakuListSurfaceFromTheme(theme, prefersDark),
    [theme, prefersDark],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setPrefersDark(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // 过滤设置变化期间保持事件订阅稳定，
  // 使隐藏页签的有界队列不会在监听空档丢失消息。
  useLayoutEffect(() => {
    matchersRef.current = { shieldMatcher, blockedUserMatcher, filterGifts };
  }, [shieldMatcher, blockedUserMatcher, filterGifts]);

  // 与屏蔽词不同，屏蔽用户是即时承诺：点击后该用户的既有行立刻从列表消失，
  // 而不是等自然裁剪淘汰。解除屏蔽不回填历史 —— 被删的行已不可恢复，
  // 新消息会照常流入。保持相同引用，未命中时避免无效重渲染。
  useLayoutEffect(() => {
    setItems((previous) => {
      const next = previous.filter((line) => !blockedUserMatcher(line.event));
      return next.length === previous.length ? previous : next;
    });
  }, [blockedUserMatcher]);

  useLayoutEffect(() => {
    activeRef.current = active;
    return () => {
      activeRef.current = false;
    };
  }, [active]);

  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (visible) scheduleFlushRef.current();
  }, [visible]);

  useEffect(() => {
    const pending = pendingRef.current;
    const cancelFlush = () => {
      if (flushFrameRef.current !== null) {
        cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };

    if (!active) {
      cancelFlush();
      pending.clear();
      nextIdRef.current = 0;
      lastFlushAtRef.current = 0;
      autoScroll.current = true;
      unreadCountRef.current = 0;
      pendingTrimRef.current = null;
      setAtBottom(true);
      setUnreadCount(0);
      setItems([]);
      return;
    }

    const flush = () => {
      flushFrameRef.current = null;
      // `keepMounted` 让页签切换保留当前消息列表。本面板隐藏期间把新事件扣在有界
      // 队列里，使聊天流量无法协调数百个不可见的 React 节点。
      if (!activeRef.current || !visibleRef.current) return;
      // 队列里的行可能携带刚被屏蔽的用户（订阅回调之后才生效），出队时再过一遍。
      // 匹配器是 Set 查找，重复调用的开销可以忽略。
      const batch = pending
        .take(MAX_PER_FLUSH)
        .filter((line) => !matchersRef.current.blockedUserMatcher(line.event));
      if (batch.length === 0) return;
      lastFlushAtRef.current = performance.now();

      if (!autoScroll.current) {
        // 信息流在历史浏览中被刻意钉住：记录此后到达的数量，
        // 显示在跳回控件上。
        unreadCountRef.current += batch.length;
        setUnreadCount(unreadCountRef.current);
      }

      // 淘汰最旧的行会把剩余行上移，只有当信息流钉在最新消息上时读者才察觉不到。
      // 读者翻看历史时保持更宽的窗口；钉住窗口由 `scrollToBottom` 恢复。
      const capacity = danmakuListAppendCapacity(autoScroll.current);
      setItems((previous) => appendWithinDanmakuListWindow(previous, batch, capacity));

      // 突发流量不应让每个动画帧都协调数百个节点。原生源已经合并了消息；
      // 为隐藏页签积压或超大原生批次保留本地节奏上限。
      if (pending.length > 0) scheduleFlush();
    };

    const scheduleFlush = () => {
      if (
        !activeRef.current ||
        !visibleRef.current ||
        pending.length === 0 ||
        flushFrameRef.current !== null ||
        flushTimerRef.current !== null
      ) {
        return;
      }

      // 正常流量下快速列表有用，但持续突发不需要每秒 31 次 React 提交。
      // 以更从容的节奏排空更大的有界积压，追平后回到低延迟路径。
      const minInterval =
        pending.length >= BACKPRESSURE_PENDING_THRESHOLD
          ? BACKPRESSURE_FLUSH_INTERVAL_MS
          : MIN_FLUSH_INTERVAL_MS;
      const remaining = minInterval - (performance.now() - lastFlushAtRef.current);
      if (remaining > 0) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          scheduleFlush();
        }, remaining);
        return;
      }
      flushFrameRef.current = requestAnimationFrame(flush);
    };
    scheduleFlushRef.current = scheduleFlush;

    const unsubscribe = subscribeDanmakuBatches((events) => {
      if (!activeRef.current) return;
      const {
        shieldMatcher: currentShieldMatcher,
        blockedUserMatcher: currentBlockedUserMatcher,
        filterGifts: currentFilterGifts,
      } = matchersRef.current;
      const accepted: DanmakuLine[] = [];
      for (const message of events) {
        if (!shouldShowValidatedInDanmakuPanel(message, currentFilterGifts)) continue;
        if (currentShieldMatcher(message)) continue;
        if (currentBlockedUserMatcher(message)) continue;
        accepted.push({ id: ++nextIdRef.current, event: message });
      }

      pending.pushAll(accepted);
      if (accepted.length === 0) return;
      scheduleFlush();
    });
    return () => {
      unsubscribe();
      cancelFlush();
      if (scheduleFlushRef.current === scheduleFlush) scheduleFlushRef.current = () => {};
      pending.clear();
    };
  }, [active]);

  useLayoutEffect(() => {
    if (!visible) return;

    if (autoScroll.current) {
      // 已钉住：先归还读者翻历史期间保留的行，再钉住。钉住状态下裁剪不可见，
      // 因为内容底部不动，偏移由浏览器代为钳制。
      if (items.length > DANMAKU_LIST_MAX_PINNED) {
        setItems((previous) => trimToDanmakuListWindow(previous, DANMAKU_LIST_MAX_PINNED));
      }
      // Base UI 拥有嵌套视口，用 `scrollIntoView` 滚动哨兵元素可能选中外层祖先而非
      // 聊天视口。只设置真正的视口，每批提交一次。
      scrollDanmakuViewportToBottom(scrollRootRef.current);
      return;
    }

    // 读者停在历史里，`flush` 在未裁剪的情况下追加了行。在这里执行更大的窗口限制，
    // 因为此时被移除的行可以被测量：移除它们会让下方所有内容上移其高度，
    // 在同一帧内从 `scrollTop` 扣掉即可保持阅读位置不动。浏览器随后钳制掉的
    // 本来就在内容之外。
    if (items.length <= DANMAKU_LIST_MAX_SCROLLED_UP) return;
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(SCROLL_VIEWPORT_SELECTOR);
    const heightBeforeTrim = viewport?.scrollHeight ?? 0;
    setItems((previous) => trimToDanmakuListWindow(previous, DANMAKU_LIST_MAX_SCROLLED_UP));
    pendingTrimRef.current = viewport ? { viewport, heightBeforeTrim } : null;
    // `atBottom` 是依赖项，因此重新钉住会重跑本副作用，即使没有新批次到达 ——
    // 这正是归还保留历史行的机制。
  }, [items, visible, atBottom]);

  // 在上面的裁剪提交之后运行，因此 `scrollHeight` 已反映被移除的行。
  // 补偿放在这里而不是裁剪自身的提交里，
  // 可以把测量排除出常见钉住场景的冲刷路径。
  useLayoutEffect(() => {
    const pendingTrim = pendingTrimRef.current;
    if (!pendingTrim) return;
    pendingTrimRef.current = null;
    const { viewport, heightBeforeTrim } = pendingTrim;
    viewport.scrollTop = scrollTopAfterDanmakuListTrim(
      viewport.scrollTop,
      heightBeforeTrim,
      viewport.scrollHeight,
    );
  }, [items]);

  useEffect(() => {
    if (!visible || typeof ResizeObserver === "undefined") return;
    const root = scrollRootRef.current;
    const viewport = root?.querySelector<HTMLElement>(SCROLL_VIEWPORT_SELECTOR);
    if (!viewport) return;

    // 页签切换或侧栏/窗口缩放可能改变视口，发生在 React 的消息批次布局副作用
    // 之后。这种情况下直播信息流也要保持钉住；手动向上滚动会关闭这条路径。
    let frame: number | null = null;
    const scrollIfPinned = () => {
      if (!autoScroll.current || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (autoScroll.current) scrollDanmakuViewportToBottom(root);
      });
    };
    const observer = new ResizeObserver(scrollIfPinned);
    observer.observe(viewport);
    scrollIfPinned();

    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [visible]);

  useEffect(() => {
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(SCROLL_VIEWPORT_SELECTOR);
    if (!viewport) return;

    // React 的委托 scroll 处理器对每次程序化钉住和用户滚动都会运行。本监听器在
    // 热路径上只修改 refs，仅在钉住状态翻转时上报，因此直接以 passive 方式
    // 挂到真正的嵌套视口上。
    const updateAutoScroll = () => {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const next = distanceToBottom < 48;
      const repinned = next && !autoScroll.current;
      autoScroll.current = next;
      setAtBottom((previous) => (previous === next ? previous : next));
      // 手动向下滚回会像跳回控件一样重新钉住信息流。清除未读计数触发重渲染，
      // 让上方布局副作用归还为阅读历史而保留的行。
      if (repinned) {
        unreadCountRef.current = 0;
        setUnreadCount(0);
      }
    };
    viewport.addEventListener("scroll", updateAutoScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", updateAutoScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    autoScroll.current = true;
    unreadCountRef.current = 0;
    setUnreadCount(0);
    // 现在就钉住；`atBottom` 翻转后上方布局副作用归还保留的历史行，
    // 使淘汰造成的位移落在钉住状态下。
    setAtBottom(true);
    scrollDanmakuViewportToBottom(scrollRootRef.current);
  }, []);

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <div ref={scrollRootRef} className="relative min-h-0 flex-1">
        <ScrollArea className="h-full min-h-0">
          <div
            className="flex flex-col gap-0.5 px-2.5 py-2 text-sm"
            // 让侧列表独立于继承来的悬浮弹幕描边样式。
            style={{ WebkitTextStroke: "0px", paintOrder: "normal" }}
          >
            {statusText && (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">{statusText}</p>
            )}
            {!active && !statusText && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                进入直播间后显示弹幕
              </p>
            )}
            {active && items.length === 0 && !statusText && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">等待弹幕…</p>
            )}
            {items.map((line) => (
              <DanmakuRow
                key={line.id}
                line={line}
                siteId={siteId}
                roomId={roomId}
                roomTitle={roomTitle}
                roomUserName={roomUserName}
                surface={listSurface}
              />
            ))}
          </div>
        </ScrollArea>

        {visible && active && !atBottom && (
          <Button
            data-mobile-static-backdrop
            type="button"
            aria-label="滚动到底部"
            title="滚动到底部"
            onClick={scrollToBottom}
            className="absolute right-2.5 bottom-2.5 z-10 size-10 rounded-full border border-border/80 bg-background/90 p-0 shadow-lg shadow-black/20 backdrop-blur animate-in fade-in"
          >
            <ArrowDownToLine className="size-4.5" aria-hidden />
            {unreadCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-4.5 rounded-full bg-primary px-1 py-px text-center text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Button>
        )}
      </div>
    </div>
  );
});
