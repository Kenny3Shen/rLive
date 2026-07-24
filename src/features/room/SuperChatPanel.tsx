import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createShieldMatcher, isDanmakuEvent } from "./danmaku/filter";
import {
  formatSuperChatAmount,
  formatSuperChatDuration,
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
  className?: string;
};

export function SuperChatPanel({ active, visible = true, className }: SuperChatPanelProps) {
  const [items, setItems] = useState<SuperChatLine[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const pendingRef = useRef<SuperChatLine[]>([]);
  const flushFrameRef = useRef<number | null>(null);
  const scheduleFlushRef = useRef<() => void>(() => {});
  const nextIdRef = useRef(0);
  const dedupeKeysRef = useRef(new Set<string>());
  const dedupeOrderRef = useRef<string[]>([]);
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
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

  useEffect(() => {
    if (autoScroll.current) {
      bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    }
  }, [items]);

  function onViewportScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    autoScroll.current = distanceToBottom < 48;
  }

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <ScrollArea className="min-h-0 flex-1" onScrollCapture={onViewportScroll}>
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
            const palette = superChatPalette(info);

            return (
              <div
                key={id}
                className={cn(
                  "rounded-lg border px-2.5 py-2 shadow-sm",
                  palette ? "" : "border-amber-500/30 bg-amber-500/10",
                )}
                style={
                  palette
                    ? {
                        background: palette.background,
                        borderColor: palette.borderColor,
                      }
                    : undefined
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <p
                    className={cn(
                      "min-w-0 truncate text-xs font-semibold",
                      !palette && "text-amber-300",
                    )}
                    style={palette ? { color: palette.foreground } : undefined}
                    title={line.user}
                  >
                    {line.user}
                  </p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {amount && (
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-xs font-bold",
                          palette ? "bg-black/15" : "bg-amber-500/15 text-amber-300",
                        )}
                        style={palette ? { color: palette.foreground } : undefined}
                      >
                        {amount}
                      </span>
                    )}
                    {duration && (
                      <span
                        className={cn("text-[11px]", !palette && "text-muted-foreground")}
                        style={palette ? { color: palette.mutedForeground } : undefined}
                      >
                        {duration}
                      </span>
                    )}
                  </div>
                </div>
                <p
                  className={cn(
                    "mt-0.5 whitespace-pre-wrap break-words leading-relaxed",
                    !palette && "text-foreground/95",
                  )}
                  style={palette ? { color: palette.foreground } : undefined}
                >
                  {line.content}
                </p>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
