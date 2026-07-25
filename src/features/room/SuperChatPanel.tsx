import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createShieldMatcher, isDanmakuEvent } from "./danmaku/filter";
import { DanmakuRichText } from "./danmaku/emoji";
import { batchEvents, type DanmakuBatch } from "./danmaku/batch";
import { BoundedQueue } from "./danmaku/boundedQueue";
import {
  formatSuperChatAmount,
  formatSuperChatDuration,
  DEFAULT_SUPER_CHAT_PALETTE,
  MAX_BUFFERED_SUPER_CHATS,
  MAX_SUPER_CHAT_DEDUPE_KEYS,
  MAX_SUPER_CHATS_PER_FRAME,
  retainSuperChatItems,
  superChatDedupeKey,
  superChatPalette,
  type SuperChatLine,
} from "./superChat";
import { cn } from "@/lib/utils";

const SCROLL_VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';
const MIN_FLUSH_INTERVAL_MS = 32;

function scrollSuperChatViewportToBottom(root: HTMLElement | null): void {
  const viewport = root?.querySelector<HTMLElement>(SCROLL_VIEWPORT_SELECTOR);
  if (!viewport) return;
  const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  if (Math.abs(viewport.scrollTop - target) > 1) viewport.scrollTop = target;
}

/** Existing cards retain their line reference, so only incoming SCs rerender. */
const SuperChatCard = memo(function SuperChatCard({ line }: { line: SuperChatLine }) {
  const event = line.event;
  const info = event.super_chat;
  const amount = formatSuperChatAmount(info);
  const duration = formatSuperChatDuration(info);
  const palette = superChatPalette(info) ?? DEFAULT_SUPER_CHAT_PALETTE;

  return (
    <article
      data-slot="super-chat-card"
      className="overflow-hidden rounded-md bg-card px-2.5 py-1.5 shadow-sm shadow-black/10"
    >
      <header className="flex min-w-0 items-center gap-2">
        <p className="min-w-0 flex-1" title={event.user}>
          <span
            className="block max-w-full truncate rounded px-1.5 py-0.5 text-xs leading-4 font-semibold"
            style={{
              backgroundColor: palette.senderBackground,
              color: palette.senderForeground,
            }}
          >
            {event.user.trim() || "匿名用户"}
          </span>
        </p>
        {duration && <span className="shrink-0 text-[11px] text-muted-foreground">{duration}</span>}
        <span
          className="shrink-0 text-sm leading-none font-bold tabular-nums"
          style={{ color: palette.amountForeground }}
        >
          {amount ?? "SC"}
        </span>
      </header>
      <p
        className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[13px] leading-5"
        title={event.content}
      >
        <DanmakuRichText content={event.content} spans={event.spans} />
      </p>
    </article>
  );
});

type SuperChatPanelProps = {
  active: boolean;
  /** Keep buffered SCs while this keep-mounted tab is hidden. */
  visible?: boolean;
  /** Reports validated SCs received while this tab is not visible. */
  onUnreadCountChange?: (count: number) => void;
  className?: string;
};

export function SuperChatPanel({
  active,
  visible = true,
  onUnreadCountChange,
  className,
}: SuperChatPanelProps) {
  const [items, setItems] = useState<SuperChatLine[]>([]);
  const [newItemsBelow, setNewItemsBelow] = useState(0);
  const newItemsBelowRef = useRef(0);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const pendingRef = useRef(new BoundedQueue<SuperChatLine>(MAX_BUFFERED_SUPER_CHATS));
  const flushFrameRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const lastFlushAtRef = useRef(0);
  const scheduleFlushRef = useRef<() => void>(() => {});
  const nextIdRef = useRef(0);
  const dedupeKeysRef = useRef(new Set<string>());
  const dedupeOrderRef = useRef<string[]>([]);
  const dedupeHeadRef = useRef(0);
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  const unreadCountRef = useRef(0);
  const onUnreadCountChangeRef = useRef(onUnreadCountChange);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);
  const fontWeight = useSettingsStore((s) => s.danmakuFontWeight);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
  const shieldMatcherRef = useRef(shieldMatcher);

  // Keep the native event listener alive while settings change. Resetting it
  // used to reset `nextIdRef` while old rows were still rendered, producing
  // duplicate React keys after a shield-word edit.
  useLayoutEffect(() => {
    shieldMatcherRef.current = shieldMatcher;
  }, [shieldMatcher]);

  useLayoutEffect(() => {
    onUnreadCountChangeRef.current = onUnreadCountChange;
    onUnreadCountChange?.(unreadCountRef.current);
  }, [onUnreadCountChange]);

  function setUnreadCount(nextCount: number) {
    const bounded = Math.max(0, Math.min(MAX_BUFFERED_SUPER_CHATS, nextCount));
    if (unreadCountRef.current === bounded) return;
    unreadCountRef.current = bounded;
    onUnreadCountChangeRef.current?.(bounded);
  }

  function setNewItemsBelowCount(nextCount: number) {
    const bounded = Math.max(0, Math.min(MAX_BUFFERED_SUPER_CHATS, nextCount));
    if (newItemsBelowRef.current === bounded) return;
    newItemsBelowRef.current = bounded;
    setNewItemsBelow(bounded);
  }

  useLayoutEffect(() => {
    activeRef.current = active;
    return () => {
      activeRef.current = false;
    };
  }, [active]);

  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (visible) {
      setUnreadCount(0);
      scheduleFlushRef.current();
    }
  }, [visible]);

  useEffect(() => {
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

    const resetSession = () => {
      cancelFlush();
      pendingRef.current.clear();
      dedupeKeysRef.current.clear();
      dedupeOrderRef.current = [];
      dedupeHeadRef.current = 0;
      nextIdRef.current = 0;
      lastFlushAtRef.current = 0;
    };

    if (!active) {
      resetSession();
      autoScroll.current = true;
      setUnreadCount(0);
      setNewItemsBelowCount(0);
      setItems([]);
      return;
    }

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const flush = () => {
      flushFrameRef.current = null;
      if (!activeRef.current || !visibleRef.current) return;
      const batch = pendingRef.current.take(MAX_SUPER_CHATS_PER_FRAME);
      if (batch.length === 0) return;
      lastFlushAtRef.current = performance.now();

      setItems((previous) => retainSuperChatItems(previous, batch));
      if (!autoScroll.current) {
        setNewItemsBelowCount(newItemsBelowRef.current + batch.length);
      }

      // Drain a hidden-tab backlog at a capped cadence so one websocket spike
      // cannot force a large React reconciliation in every paint.
      if (pendingRef.current.length > 0) scheduleFlush();
    };

    const scheduleFlush = () => {
      if (
        !activeRef.current ||
        !visibleRef.current ||
        pendingRef.current.length === 0 ||
        flushFrameRef.current !== null ||
        flushTimerRef.current !== null
      ) {
        return;
      }

      const remaining = MIN_FLUSH_INTERVAL_MS - (performance.now() - lastFlushAtRef.current);
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

    const rememberDedupeKey = (key: string): boolean => {
      if (dedupeKeysRef.current.has(key)) return false;

      dedupeKeysRef.current.add(key);
      const order = dedupeOrderRef.current;
      order.push(key);
      if (order.length - dedupeHeadRef.current > MAX_SUPER_CHAT_DEDUPE_KEYS) {
        const oldest = order[dedupeHeadRef.current];
        dedupeHeadRef.current += 1;
        if (oldest) dedupeKeysRef.current.delete(oldest);
        // Avoid shifting a 240-item array once per SC. Compact occasionally
        // instead, which is O(1) amortized across sustained traffic.
        if (dedupeHeadRef.current >= 128 && dedupeHeadRef.current * 2 >= order.length) {
          dedupeOrderRef.current = order.slice(dedupeHeadRef.current);
          dedupeHeadRef.current = 0;
        }
      }
      return true;
    };

    void listen<DanmakuBatch>("danmaku-batch", (event) => {
      if (cancelled || !activeRef.current) return;
      const accepted: SuperChatLine[] = [];
      for (const message of batchEvents(event.payload)) {
        // Most traffic is ordinary chat. Check the discriminator before the
        // full native-payload validation to keep the hidden SC tab inexpensive.
        if (
          !message ||
          typeof message !== "object" ||
          (message as { kind?: unknown }).kind !== "super_chat" ||
          !isDanmakuEvent(message) ||
          !message.content.trim() ||
          shieldMatcherRef.current(message)
        ) {
          continue;
        }

        if (!rememberDedupeKey(superChatDedupeKey(message))) continue;
        accepted.push({ id: ++nextIdRef.current, event: message });
      }
      if (accepted.length === 0) return;

      pendingRef.current.pushAll(accepted);
      if (!visibleRef.current) setUnreadCount(unreadCountRef.current + accepted.length);
      scheduleFlush();
    })
      .then((fn) => {
        if (cancelled) {
          void fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
      // Session state is reset only when `active` becomes false. A live
      // setting change must not recycle row ids or discard a hidden-tab queue.
      cancelFlush();
      if (scheduleFlushRef.current === scheduleFlush) scheduleFlushRef.current = () => {};
    };
  }, [active]);

  useLayoutEffect(() => {
    if (!visible || !autoScroll.current) return;

    // ScrollArea's viewport is nested. Going through a sentinel's
    // `scrollIntoView` can choose an ancestor instead, leaving this list at
    // an older message. Set its real viewport once after each batch instead
    // of issuing a second identical scroll write on the following frame.
    scrollSuperChatViewportToBottom(scrollRootRef.current);
  }, [items, visible]);

  useEffect(() => {
    if (!visible || typeof ResizeObserver === "undefined") return;
    const root = scrollRootRef.current;
    const viewport = root?.querySelector<HTMLElement>(SCROLL_VIEWPORT_SELECTOR);
    if (!viewport) return;

    let frame: number | null = null;
    const scrollIfPinned = () => {
      if (!autoScroll.current || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (autoScroll.current) scrollSuperChatViewportToBottom(root);
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

    const updateAutoScroll = () => {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      autoScroll.current = distanceToBottom < 48;
      if (autoScroll.current) setNewItemsBelowCount(0);
    };
    viewport.addEventListener("scroll", updateAutoScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", updateAutoScroll);
  }, []);

  function jumpToLatest() {
    autoScroll.current = true;
    setNewItemsBelowCount(0);
    scrollSuperChatViewportToBottom(scrollRootRef.current);
  }

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <div ref={scrollRootRef} className="relative min-h-0 flex-1">
        <ScrollArea className="h-full min-h-0">
          <div
            className="flex flex-col gap-2 px-2.5 py-2"
            style={{
              fontSize: Math.max(12, (fontSize || 16) - 4),
              fontWeight,
            }}
          >
            {active && items.length === 0 && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">等待醒目留言…</p>
            )}
            {!active && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                进入直播间后显示 SC
              </p>
            )}
            {items.map((line) => (
              <SuperChatCard key={line.id} line={line} />
            ))}
          </div>
        </ScrollArea>
        {visible && newItemsBelow > 0 && (
          <button
            type="button"
            className="absolute inset-x-0 bottom-3 z-10 mx-auto w-fit rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-lg shadow-black/25 transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={jumpToLatest}
          >
            {newItemsBelow > 99 ? "99+" : newItemsBelow} 条新 SC
          </button>
        )}
      </div>
    </div>
  );
}
