import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ArrowDownToLine, Ban, Copy, MessageSquarePlus, Star } from "lucide-react";
import type { DanmakuEvent, SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  createBlockedUserMatcher,
  createShieldMatcher,
  shouldShowValidatedInDanmakuPanel,
} from "./danmaku/filter";
import { subscribeDanmakuBatches } from "./danmaku/eventBus";
import { BoundedQueue } from "./danmaku/boundedQueue";
import { appendWithinDanmakuListWindow } from "./danmaku/listWindow";
import {
  danmakuListSurfaceFromTheme,
  resolveDanmakuListUserColor,
  type DanmakuListSurface,
} from "./danmaku/listColor";
import { formatDanmakuClipboardText, useDanmakuActions } from "./danmaku/useDanmakuActions";
import { cn } from "@/lib/utils";

// 有界队列只负责隐藏页签或突发流量期间的待提交事件；已提交的历史由虚拟器窗口化渲染。
const MAX_BUFFERED = 200;
const MAX_PER_FLUSH = 32;
const MIN_FLUSH_INTERVAL_MS = 32;
const BACKPRESSURE_FLUSH_INTERVAL_MS = 80;
const BACKPRESSURE_PENDING_THRESHOLD = MAX_PER_FLUSH * 2;
const SCROLL_VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';
// text-sm 的 14px × leading-relaxed 1.625 + py-1 8px + border 2px，
// 虚拟器测高会取整到 33px。贴近常见单行，避免每批新增行都触发估高修正与额外布局。
const DANMAKU_ROW_ESTIMATE_PX = 33;
const DANMAKU_LIST_OVERSCAN = 6;

type DanmakuLine = { id: number; event: DanmakuEvent };

type DanmakuPanelMenuTarget = {
  line: DanmakuLine;
  anchor: { getBoundingClientRect: () => DOMRect };
  trigger: HTMLElement;
};

function scrollDanmakuViewportToBottom(viewport: HTMLElement | null): void {
  if (!viewport) return;
  const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  // 即使在已钉住时赋值 `scrollTop` 也可能在原语内派发额外的滚动工作。
  // 避免在每次批量 React 提交上都做这次同步写入。
  if (Math.abs(viewport.scrollTop - target) > 1) viewport.scrollTop = target;
}

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
    <span className="mr-1.5 text-primary" style={userColor ? { color: userColor } : undefined}>
      {user}：
    </span>
  );
}

/**
 * 虚拟窗口内的轻量行。行不再拥有 Popover、状态或查询；交互由面板根节点委托，
 * 因而可视窗口外的消息完全没有 React 行组件。
 */
const DanmakuRow = memo(function DanmakuRow({
  line,
  surface,
  selected,
  menuId,
}: {
  line: DanmakuLine;
  surface: DanmakuListSurface;
  selected: boolean;
  menuId: string;
}) {
  const { event } = line;
  const user = event.user.trim() || "匿名";
  const message = formatDanmakuClipboardText(event.content);
  const selectable = event.kind !== "system" && message.length > 0;

  const Row = selectable ? "button" : "div";

  return (
    <Row
      type={selectable ? "button" : undefined}
      data-danmaku-id={selectable ? line.id : undefined}
      aria-label={selectable ? `选择 ${user} 的弹幕` : undefined}
      aria-haspopup={selectable ? "dialog" : undefined}
      aria-expanded={selectable ? selected : undefined}
      aria-controls={selected ? menuId : undefined}
      className={cn(
        "block w-full rounded-md border border-transparent px-1.5 py-1 text-left break-words leading-relaxed font-semibold",
        event.kind === "system" && "text-xs font-normal text-muted-foreground",
        selectable &&
          "cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted",
        event.is_self === true && "border-primary/60",
      )}
    >
      {event.kind !== "system" && <DanmakuSender event={event} user={user} surface={surface} />}
      {event.content}
    </Row>
  );
});

const DanmakuPanelActionMenu = memo(function DanmakuPanelActionMenu({
  target,
  menuId,
  viewport,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  onClose,
}: {
  target: DanmakuPanelMenuTarget;
  menuId: string;
  viewport: HTMLElement | null;
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  onClose: () => void;
}) {
  const event = target.line.event;
  const message = formatDanmakuClipboardText(event.content);
  const actions = useDanmakuActions({
    message,
    eventKind: event.kind,
    user: event.user,
    siteId,
    roomId,
    roomTitle,
    roomUserName,
  });

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverContent
        id={menuId}
        aria-label={`${event.user.trim() || "匿名"} 的弹幕操作`}
        anchor={target.anchor}
        side="left"
        align="start"
        className="w-40 p-1"
        initialFocus
        finalFocus={() => (target.trigger.isConnected ? target.trigger : (viewport ?? false))}
      >
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
              onClose();
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
  /** 当前房间身份，同时用于显式的「+1」发送操作。 */
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
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const autoScroll = useRef(true);
  const readingKeyRef = useRef<number | null>(null);
  const unreadCountRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [menuTarget, setMenuTarget] = useState<DanmakuPanelMenuTarget | null>(null);
  const menuTargetRef = useRef(menuTarget);
  menuTargetRef.current = menuTarget;
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const pendingRef = useRef(new BoundedQueue<DanmakuLine>(MAX_BUFFERED));
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

  // 过滤设置变化期间保持事件订阅稳定，使隐藏页签的有界队列不会在监听空档丢失消息。
  useLayoutEffect(() => {
    matchersRef.current = { shieldMatcher, blockedUserMatcher, filterGifts };
  }, [shieldMatcher, blockedUserMatcher, filterGifts]);

  // 屏蔽用户是即时承诺：点击后既有行立即消失；解除屏蔽不回填历史。
  const [prevBlockedMatcher, setPrevBlockedMatcher] = useState(() => blockedUserMatcher);
  if (blockedUserMatcher !== prevBlockedMatcher) {
    setPrevBlockedMatcher(() => blockedUserMatcher);
    setItems((previous) => {
      const next = previous.filter((line) => !blockedUserMatcher(line.event));
      return next.length === previous.length ? previous : next;
    });
  }

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

  // 停用或换房立即清空，避免旧房间的菜单拿着新 roomId 发送。
  const [previousContext, setPreviousContext] = useState({ active, siteId, roomId });
  if (
    active !== previousContext.active ||
    siteId !== previousContext.siteId ||
    roomId !== previousContext.roomId
  ) {
    setPreviousContext({ active, siteId, roomId });
    setAtBottom(true);
    setUnreadCount(0);
    setMenuTarget(null);
    setItems([]);
  }

  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (!visible) setMenuTarget(null);
  }
  if (
    menuTarget &&
    (blockedUserMatcher(menuTarget.line.event) || !items.includes(menuTarget.line))
  ) {
    setMenuTarget(null);
  }

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

    cancelFlush();
    pending.clear();
    nextIdRef.current = 0;
    lastFlushAtRef.current = 0;
    autoScroll.current = true;
    unreadCountRef.current = 0;
    readingKeyRef.current = null;
    if (!active) return;

    const flush = () => {
      flushFrameRef.current = null;
      // `keepMounted` 让页签切换保留当前消息列表。隐藏期间把新事件扣在有界队列里，
      // 使聊天流量无法协调不可见的 React 节点。
      if (!activeRef.current || !visibleRef.current) return;
      const batch = pending
        .take(MAX_PER_FLUSH)
        .filter((line) => !matchersRef.current.blockedUserMatcher(line.event));
      if (batch.length === 0) {
        if (pending.length > 0) scheduleFlush();
        return;
      }
      lastFlushAtRef.current = performance.now();

      if (!autoScroll.current) {
        unreadCountRef.current += batch.length;
        setUnreadCount(unreadCountRef.current);
      }

      // 数据仍有界；裁剪后由虚拟器的稳定键锚定代替整段高度差补偿。
      setItems((previous) => appendWithinDanmakuListWindow(previous, batch));

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
  }, [active, siteId, roomId]);

  useLayoutEffect(() => {
    const root = scrollRootRef.current;
    const next = root?.querySelector<HTMLElement>(SCROLL_VIEWPORT_SELECTOR) ?? null;
    setViewport((current) => (current === next ? current : next));
  }, []);

  const getItemKey = useCallback((index: number) => items[index].id, [items]);
  // 用真实 viewport 给虚拟器，而不是 ScrollArea 外层。
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => (visible ? viewport : null),
    estimateSize: () => DANMAKU_ROW_ESTIMATE_PX,
    getItemKey,
    paddingStart: 8,
    paddingEnd: 8,
    gap: 2,
    overscan: DANMAKU_LIST_OVERSCAN,
    anchorTo: "end",
    // 跟随由下方同步 scrollTop 完成，不启用 scrollToEnd 的跨帧重试；
    // 否则快速上滚时尚未结束的重试会把阅读位置拉回底部。
    useFlushSync: false,
  });

  // 长文本和面板变窄会换行：仅测量挂载的可视行，不把近似估高当成固定行高。
  // 缓存按稳定 id 保存，淘汰数据后也释放对应测高，避免长时间直播积累无用键。
  useLayoutEffect(() => {
    const keys = new Set(items.map((line) => line.id));
    for (const key of virtualizer.itemSizeCache.keys()) {
      if (typeof key === "number" && !keys.has(key)) virtualizer.itemSizeCache.delete(key);
    }
  }, [items, virtualizer]);

  // 锚点仍在窗口内时由虚拟器保持位置；连锚点也被淘汰时，退到最早保留行。
  useLayoutEffect(() => {
    const first = items[0];
    if (
      !autoScroll.current &&
      viewport &&
      first &&
      readingKeyRef.current !== null &&
      readingKeyRef.current < first.id
    ) {
      readingKeyRef.current = first.id;
      viewport.scrollTop = 0;
    }
  }, [items, viewport]);

  // 虚拟器处理追加时的锚定；这里同步测高、重新显示与主动回底带来的总高度变化。
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    if (visible && autoScroll.current) scrollDanmakuViewportToBottom(viewport);
  }, [items, totalSize, visible, atBottom, viewport]);

  useEffect(() => {
    if (!visible || !viewport || typeof ResizeObserver === "undefined") return;

    let frame: number | null = null;
    let previousWidth = viewport.clientWidth;
    let previousHeight = viewport.clientHeight;
    const scrollIfPinned = () => {
      if (previousWidth !== viewport.clientWidth || previousHeight !== viewport.clientHeight) {
        previousWidth = viewport.clientWidth;
        previousHeight = viewport.clientHeight;
        setMenuTarget(null);
      }
      if (!autoScroll.current || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (autoScroll.current) scrollDanmakuViewportToBottom(viewport);
      });
    };
    const observer = new ResizeObserver(scrollIfPinned);
    observer.observe(viewport);
    scrollIfPinned();

    const closeOnResize = () => setMenuTarget(null);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("resize", closeOnResize);
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [visible, viewport]);

  useEffect(() => {
    if (!visible || !viewport) return;

    // 热路径上只修改 refs，仅在钉住状态翻转时上报，避免每次 scroll 触发 React 树协调。
    const updateAutoScroll = () => {
      const key = virtualizer.getVirtualItemForOffset(viewport.scrollTop)?.key;
      readingKeyRef.current = typeof key === "number" ? key : null;
      if (menuTargetRef.current) return;
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const next = distanceToBottom < 48;
      const repinned = next && !autoScroll.current;
      autoScroll.current = next;
      setAtBottom((previous) => (previous === next ? previous : next));
      if (repinned) {
        unreadCountRef.current = 0;
        setUnreadCount(0);
      }
    };
    // 菜单锚在点击坐标；用户主动滚动/改变视口后收起，不让菜单悬在另一条消息上。
    const closeOnMove = () => setMenuTarget(null);
    viewport.addEventListener("wheel", closeOnMove, { passive: true });
    viewport.addEventListener("touchmove", closeOnMove, { passive: true });
    viewport.addEventListener("scroll", updateAutoScroll, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", closeOnMove);
      viewport.removeEventListener("touchmove", closeOnMove);
      viewport.removeEventListener("scroll", updateAutoScroll);
    };
  }, [visible, viewport, virtualizer]);

  const scrollToBottom = useCallback(() => {
    autoScroll.current = true;
    unreadCountRef.current = 0;
    setUnreadCount(0);
    setAtBottom(true);
    setMenuTarget(null);
    scrollDanmakuViewportToBottom(viewport);
  }, [viewport]);

  const closeMenu = useCallback(() => {
    setMenuTarget(null);
  }, []);

  const handleListClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLElement>("[data-danmaku-id]");
    if (!trigger || !event.currentTarget.contains(trigger)) return;
    const id = Number(trigger.dataset.danmakuId);
    const line = itemsRef.current.find((item) => item.id === id);
    if (!line) return;
    const rect = trigger.getBoundingClientRect();
    // 原生 button 为 Enter/Space/辅助技术提供 click；这种 click 没有有效指针坐标。
    const anchorRect = new DOMRect(
      event.detail === 0 ? rect.left + rect.width / 2 : event.clientX,
      event.detail === 0 ? rect.top + rect.height / 2 : event.clientY,
      0,
      0,
    );
    autoScroll.current = false;
    setAtBottom(false);
    setMenuTarget({ line, trigger, anchor: { getBoundingClientRect: () => anchorRect } });
  }, []);

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      {statusText && <p className="px-4 py-1 text-xs text-muted-foreground">{statusText}</p>}
      <div ref={scrollRootRef} className="relative min-h-0 flex-1">
        <ScrollArea className="h-full min-h-0">
          <div
            className="px-2.5 text-sm"
            // 让侧列表独立于继承来的悬浮弹幕描边样式。
            style={{ WebkitTextStroke: "0px", paintOrder: "normal" }}
            onClick={handleListClick}
          >
            {!active && !statusText && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                进入直播间后显示弹幕
              </p>
            )}
            {active && items.length === 0 && !statusText && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">等待弹幕…</p>
            )}
            <div
              data-slot="danmaku-list"
              data-count={items.length}
              className="relative"
              style={{ height: items.length > 0 ? totalSize : 0, overflowAnchor: "none" }}
            >
              {virtualRows.map((virtualRow: VirtualItem) => {
                const line = items[virtualRow.index];
                if (!line) return null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="absolute inset-x-0 top-0"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <DanmakuRow
                      line={line}
                      surface={listSurface}
                      selected={menuTarget?.line.id === line.id}
                      menuId={menuId}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </ScrollArea>

        {visible && menuTarget && (
          <DanmakuPanelActionMenu
            key={menuTarget.line.id}
            target={menuTarget}
            menuId={menuId}
            viewport={viewport}
            siteId={siteId}
            roomId={roomId}
            roomTitle={roomTitle}
            roomUserName={roomUserName}
            onClose={closeMenu}
          />
        )}

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
              // 抵掉 Badge 默认 h-5 与透明边框，否则角标会比原药丸大一圈
              <Badge className="absolute -top-1.5 -right-1.5 h-auto min-w-4.5 rounded-full border-0 px-1 py-px text-[10px] leading-4 font-semibold tabular-nums">
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </Button>
        )}
      </div>
    </div>
  );
});
