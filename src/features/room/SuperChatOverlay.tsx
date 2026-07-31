import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { BoundedQueue } from "./danmaku/boundedQueue";
import { DanmakuRichText } from "./danmaku/emoji";
import { subscribeDanmakuBatches } from "./danmaku/eventBus";
import { createShieldMatcher } from "./danmaku/filter";
import {
  DEFAULT_SUPER_CHAT_PALETTE,
  MAX_BUFFERED_SUPER_CHATS,
  MAX_SUPER_CHAT_DEDUPE_KEYS,
  MAX_SUPER_CHATS_PER_FRAME,
  MAX_VISIBLE_SUPER_CHAT_CARDS,
  formatSuperChatAmount,
  retainSuperChatItems,
  superChatAvatarUrl,
  superChatDedupeKey,
  superChatPalette,
  superChatRemainingSeconds,
  type SuperChatLine,
} from "./superChat";

const MIN_FLUSH_INTERVAL_MS = 32;

type SuperChatCountdownProps = {
  info: SuperChatLine["event"]["super_chat"];
  receivedAt: number;
  onExpired: () => void;
};

function SuperChatCountdown({ info, receivedAt, onExpired }: SuperChatCountdownProps) {
  const [now, setNow] = useState(() => Date.now());
  const remainingSeconds = superChatRemainingSeconds(info, receivedAt, now);

  useLayoutEffect(() => {
    const currentNow = Date.now();
    const currentRemaining = superChatRemainingSeconds(info, receivedAt, currentNow);
    setNow(currentNow);
    if (currentRemaining === null) return;
    if (currentRemaining <= 0) {
      onExpired();
      return;
    }

    let timeoutId: number | undefined;
    const tick = () => {
      const nextNow = Date.now();
      const nextRemaining = superChatRemainingSeconds(info, receivedAt, nextNow);
      setNow(nextNow);
      if (nextRemaining === null) return;
      if (nextRemaining <= 0) {
        onExpired();
        return;
      }
      timeoutId = window.setTimeout(tick, Math.max(1, 1_000 - (nextNow % 1_000)));
    };

    timeoutId = window.setTimeout(tick, Math.max(1, 1_000 - (currentNow % 1_000)));
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [info, onExpired, receivedAt]);

  if (remainingSeconds === null || remainingSeconds <= 0) return null;

  return (
    <time
      className="shrink-0 whitespace-nowrap text-[0.82em] leading-none font-medium tabular-nums opacity-70"
      dateTime={`PT${remainingSeconds}S`}
      aria-label={`剩余 ${remainingSeconds} 秒`}
      title={`剩余 ${remainingSeconds} 秒`}
    >
      {remainingSeconds}
    </time>
  );
}

/** Existing cards retain their line reference, so only incoming SCs rerender. */
const SuperChatCard = memo(function SuperChatCard({
  line,
  onExpired,
}: {
  line: SuperChatLine;
  onExpired: (id: number) => void;
}) {
  const event = line.event;
  const info = event.super_chat;
  const amount = formatSuperChatAmount(info);
  const palette = superChatPalette(info) ?? DEFAULT_SUPER_CHAT_PALETTE;
  const user = event.user.trim() || "匿名用户";
  const avatarUrl = superChatAvatarUrl(info);
  const avatarInitial = Array.from(user)[0] ?? "?";
  const handleExpired = useCallback(() => onExpired(line.id), [line.id, onExpired]);

  return (
    <Card
      data-super-chat-card
      size="sm"
      role="article"
      className="shrink-0 gap-0 rounded-lg py-0 shadow-lg"
    >
      <CardHeader
        className="grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-t-lg px-2.5 py-1.5"
        style={{
          backgroundColor: palette.messageStart,
          color: palette.headerForeground,
        }}
      >
        <Avatar className="size-8 shrink-0 ring-1 ring-foreground/10">
          {avatarUrl && (
            <AvatarImage
              src={avatarUrl}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
            />
          )}
          <AvatarFallback className="bg-muted font-semibold text-muted-foreground">
            {avatarInitial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <CardTitle className="truncate" title={user}>
            {user}
          </CardTitle>
          {amount && (
            <p className="mt-0.5 leading-tight font-semibold tabular-nums opacity-80">{amount}</p>
          )}
        </div>
        <SuperChatCountdown info={info} receivedAt={event.ts} onExpired={handleExpired} />
      </CardHeader>
      <CardContent
        className="rounded-b-lg px-2.5 py-2"
        style={{ backgroundColor: palette.messageEnd, color: palette.contentForeground }}
      >
        <div className="line-clamp-3 break-words leading-5 font-medium">
          <DanmakuRichText content={event.content} spans={event.spans} />
        </div>
      </CardContent>
    </Card>
  );
});

type SuperChatOverlayProps = {
  active: boolean;
  className?: string;
};

/** Bounded, non-interactive SC cards rendered over the lower-left video area. */
export const SuperChatOverlay = memo(function SuperChatOverlay({
  active,
  className,
}: SuperChatOverlayProps) {
  const [items, setItems] = useState<SuperChatLine[]>([]);
  const pendingRef = useRef(new BoundedQueue<SuperChatLine>(MAX_BUFFERED_SUPER_CHATS));
  const flushFrameRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const lastFlushAtRef = useRef(0);
  const nextIdRef = useRef(0);
  const dedupeKeysRef = useRef(new Set<string>());
  const dedupeOrderRef = useRef<string[]>([]);
  const dedupeHeadRef = useRef(0);
  const shieldWords = useSettingsStore((state) => state.danmakuShieldWords);
  const fontSize = useSettingsStore((state) => state.danmakuFontSize);
  const fontWeight = useSettingsStore((state) => state.danmakuFontWeight);
  const superChatOpacity = useSettingsStore((state) => state.superChatOpacity);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
  const shieldMatcherRef = useRef(shieldMatcher);

  useLayoutEffect(() => {
    shieldMatcherRef.current = shieldMatcher;
  }, [shieldMatcher]);

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

    resetSession();
    setItems([]);
    if (!active) return;

    const flush = () => {
      flushFrameRef.current = null;
      const batch = pendingRef.current.take(MAX_SUPER_CHATS_PER_FRAME);
      if (batch.length === 0) return;
      lastFlushAtRef.current = performance.now();
      setItems((previous) => retainSuperChatItems(previous, batch, MAX_VISIBLE_SUPER_CHAT_CARDS));
      if (pendingRef.current.length > 0) scheduleFlush();
    };

    const scheduleFlush = () => {
      if (
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

    const rememberDedupeKey = (key: string): boolean => {
      if (dedupeKeysRef.current.has(key)) return false;

      dedupeKeysRef.current.add(key);
      const order = dedupeOrderRef.current;
      order.push(key);
      if (order.length - dedupeHeadRef.current > MAX_SUPER_CHAT_DEDUPE_KEYS) {
        const oldest = order[dedupeHeadRef.current];
        dedupeHeadRef.current += 1;
        if (oldest) dedupeKeysRef.current.delete(oldest);
        if (dedupeHeadRef.current >= 128 && dedupeHeadRef.current * 2 >= order.length) {
          dedupeOrderRef.current = order.slice(dedupeHeadRef.current);
          dedupeHeadRef.current = 0;
        }
      }
      return true;
    };

    const unsubscribe = subscribeDanmakuBatches((events) => {
      const accepted: SuperChatLine[] = [];
      for (const message of events) {
        if (
          message.kind !== "super_chat" ||
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
      scheduleFlush();
    });

    return () => {
      unsubscribe();
      cancelFlush();
    };
  }, [active]);

  const removeExpiredSuperChat = useCallback((id: number) => {
    setItems((previous) => previous.filter((line) => line.id !== id));
  }, []);

  return (
    <div
      data-slot="super-chat-overlay"
      className={cn(
        "pointer-events-none flex max-h-full w-full flex-col justify-end gap-2 overflow-hidden",
        className,
      )}
      style={{
        fontSize: Math.max(12, (fontSize || 16) - 4),
        fontWeight,
        opacity: superChatOpacity,
      }}
      aria-live="polite"
      aria-relevant="additions"
    >
      {items.map((line) => (
        <SuperChatCard key={line.id} line={line} onExpired={removeExpiredSuperChat} />
      ))}
    </div>
  );
});
