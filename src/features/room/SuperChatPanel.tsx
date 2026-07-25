import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createShieldMatcher, isDanmakuEvent } from "./danmaku/filter";
import { DanmakuEmojiText } from "./danmaku/emoji";
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
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const pendingRef = useRef<SuperChatLine[]>([]);
  const flushFrameRef = useRef<number | null>(null);
  const scheduleFlushRef = useRef<() => void>(() => {});
  const nextIdRef = useRef(0);
  const dedupeKeysRef = useRef(new Set<string>());
  const dedupeOrderRef = useRef<string[]>([]);
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
    };

    const resetSession = () => {
      cancelFlush();
      pendingRef.current = [];
      dedupeKeysRef.current.clear();
      dedupeOrderRef.current = [];
      nextIdRef.current = 0;
    };

    if (!active) {
      resetSession();
      autoScroll.current = true;
      setUnreadCount(0);
      setNewItemsBelow(0);
      setItems([]);
      return;
    }

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const flush = () => {
      flushFrameRef.current = null;
      if (!activeRef.current || !visibleRef.current) return;
      const batch = pendingRef.current.splice(0, MAX_SUPER_CHATS_PER_FRAME);
      if (batch.length === 0) return;

      setItems((previous) => retainSuperChatItems(previous, batch));
      if (!autoScroll.current) {
        setNewItemsBelow((count) => Math.min(MAX_BUFFERED_SUPER_CHATS, count + batch.length));
      }

      // Drain bursts across frames so one websocket spike cannot force a large
      // React reconciliation in a single paint.
      if (pendingRef.current.length > 0) scheduleFlush();
    };

    const scheduleFlush = () => {
      if (activeRef.current && visibleRef.current && flushFrameRef.current === null) {
        flushFrameRef.current = requestAnimationFrame(flush);
      }
    };
    scheduleFlushRef.current = scheduleFlush;

    const rememberDedupeKey = (key: string): boolean => {
      if (dedupeKeysRef.current.has(key)) return false;

      dedupeKeysRef.current.add(key);
      dedupeOrderRef.current.push(key);
      if (dedupeOrderRef.current.length > MAX_SUPER_CHAT_DEDUPE_KEYS) {
        const oldest = dedupeOrderRef.current.shift();
        if (oldest) dedupeKeysRef.current.delete(oldest);
      }
      return true;
    };

    void listen<DanmakuEvent>("danmaku", (event) => {
      if (cancelled || !activeRef.current) return;
      const message = event.payload;
      if (!isDanmakuEvent(message) || message.kind !== "super_chat" || !message.content.trim()) {
        return;
      }
      if (shieldMatcherRef.current(message)) return;

      const dedupeKey = superChatDedupeKey(message);
      if (!rememberDedupeKey(dedupeKey)) return;

      const pending = pendingRef.current;
      pending.push({ id: ++nextIdRef.current, event: message });
      if (pending.length > MAX_BUFFERED_SUPER_CHATS) {
        pending.splice(0, pending.length - MAX_BUFFERED_SUPER_CHATS);
      }
      if (!visibleRef.current) {
        setUnreadCount(unreadCountRef.current + 1);
      }
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
    // an older message. Set its real viewport directly after each batch.
    const scrollToBottom = () => {
      if (!autoScroll.current) return;
      const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    };

    scrollToBottom();
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [items, visible]);

  function onViewportScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    autoScroll.current = distanceToBottom < 48;
    if (autoScroll.current) setNewItemsBelow(0);
  }

  function jumpToLatest() {
    autoScroll.current = true;
    setNewItemsBelow(0);
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <div ref={scrollRootRef} className="relative min-h-0 flex-1">
        <ScrollArea className="h-full min-h-0" onScrollCapture={onViewportScroll}>
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
            {items.map(({ id, event: line }) => {
              const info = line.super_chat;
              const amount = formatSuperChatAmount(info);
              const duration = formatSuperChatDuration(info);
              const palette = superChatPalette(info) ?? DEFAULT_SUPER_CHAT_PALETTE;

              return (
                <article
                  key={id}
                  className="overflow-hidden rounded-lg border shadow-sm shadow-black/15"
                  style={{ borderColor: palette.borderColor }}
                >
                  <header
                    className="flex min-h-12 items-center justify-between gap-3 px-3 py-2"
                    style={{
                      backgroundColor: palette.headerBackground,
                      color: palette.headerForeground,
                    }}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold" title={line.user}>
                        {line.user.trim() || "匿名用户"}
                      </p>
                      {duration && (
                        <p
                          className="mt-0.5 text-[11px]"
                          style={{ color: palette.mutedForeground }}
                        >
                          醒目留言 · {duration}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-lg leading-none font-bold tabular-nums">
                      {amount ?? "SC"}
                    </span>
                  </header>
                  <div
                    className="min-h-14 px-3 py-2.5"
                    style={{
                      backgroundColor: palette.bodyBackground,
                      color: palette.bodyForeground,
                    }}
                  >
                    <p className="whitespace-pre-wrap break-words leading-relaxed">
                      <DanmakuEmojiText content={line.content} />
                    </p>
                  </div>
                </article>
              );
            })}
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
