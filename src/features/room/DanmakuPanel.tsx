import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createShieldMatcher, shouldShowValidatedInDanmakuPanel } from "./danmaku/filter";
import { DanmakuRichText } from "./danmaku/emoji";
import { subscribeDanmakuBatches } from "./danmaku/eventBus";
import { BoundedQueue } from "./danmaku/boundedQueue";
import { cn } from "@/lib/utils";

// Keep the rendered DOM deliberately small even when a room is producing
// thousands of comments per minute. The native and pending queues preserve
// recent traffic without asking React to retain an ever-growing chat tree.
const MAX = 300;
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
  // Assigning `scrollTop` even when it is already pinned can dispatch extra
  // scroll work in the primitive. Avoid that synchronous write on every
  // batched React commit.
  if (Math.abs(viewport.scrollTop - target) > 1) viewport.scrollTop = target;
}

type DanmakuLine = {
  id: number;
  event: DanmakuEvent;
};

/**
 * Appending a batch keeps prior `DanmakuLine` references intact. Memoizing a
 * row therefore avoids reconciling up to 300 already-rendered messages for
 * each animation-frame flush in a busy room.
 */
const DanmakuRow = memo(function DanmakuRow({ event }: { event: DanmakuEvent }) {
  if (event.kind === "system") {
    return (
      <div className="px-1.5 py-0.5 text-xs text-muted-foreground">
        <DanmakuRichText content={event.content} spans={event.spans} />
      </div>
    );
  }

  return (
    <div className="rounded-md px-1.5 py-1 leading-relaxed hover:bg-muted/50">
      <span
        className="mr-1.5 font-medium text-primary"
        style={event.color ? { color: event.color } : undefined}
      >
        {event.user.trim() || "匿名"}：
      </span>
      <DanmakuRichText content={event.content} spans={event.spans} className="text-foreground/90" />
    </div>
  );
});

type DanmakuPanelProps = {
  active: boolean;
  /** Keep collecting while another room-side tab is open, without repainting it. */
  visible?: boolean;
  className?: string;
  statusText?: string | null;
};

export const DanmakuPanel = memo(function DanmakuPanel({
  active,
  visible = true,
  className,
  statusText,
}: DanmakuPanelProps) {
  const [items, setItems] = useState<DanmakuLine[]>([]);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const pendingRef = useRef(new BoundedQueue<DanmakuLine>(MAX_BUFFERED));
  const flushFrameRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const lastFlushAtRef = useRef(0);
  const scheduleFlushRef = useRef<() => void>(() => {});
  const nextIdRef = useRef(0);
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const filterGifts = useSettingsStore((s) => s.danmakuFilterGifts);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);
  const fontWeight = useSettingsStore((s) => s.danmakuFontWeight);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
  const matchersRef = useRef({ shieldMatcher, filterGifts });

  // Keep the event subscription stable while a filter setting changes so the
  // bounded hidden-tab queue does not lose messages in a listener gap.
  useLayoutEffect(() => {
    matchersRef.current = { shieldMatcher, filterGifts };
  }, [shieldMatcher, filterGifts]);

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
      setItems([]);
      return;
    }

    const flush = () => {
      flushFrameRef.current = null;
      // `keepMounted` makes tab changes preserve the current message list.
      // Hold new events in the bounded queue while this panel is hidden so
      // chat traffic cannot reconcile hundreds of invisible React nodes.
      if (!activeRef.current || !visibleRef.current) return;
      const batch = pending.take(MAX_PER_FLUSH);
      if (batch.length === 0) return;
      lastFlushAtRef.current = performance.now();

      setItems((previous) => {
        const next = previous.concat(batch);
        if (next.length <= MAX) return next;
        return next.slice(next.length - MAX);
      });

      // A burst should not make every animation frame reconcile hundreds of
      // nodes. The native source already coalesces messages; retain a local
      // cadence cap for a hidden-tab backlog or a very large native batch.
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

      // A fast list is useful at normal traffic, but a sustained burst does
      // not need 31 React commits per second. Drain a larger bounded backlog
      // at a calmer cadence and return to the low-latency path once caught up.
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
      const { shieldMatcher: currentShieldMatcher, filterGifts: currentFilterGifts } =
        matchersRef.current;
      const accepted: DanmakuLine[] = [];
      for (const message of events) {
        if (!shouldShowValidatedInDanmakuPanel(message, currentFilterGifts)) continue;
        if (currentShieldMatcher(message)) continue;
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
    if (!visible || !autoScroll.current) return;

    // Base UI owns a nested viewport, so scrolling a sentinel with
    // `scrollIntoView` can select an outer ancestor instead of the chat
    // viewport. Set only the actual viewport, once per committed batch.
    scrollDanmakuViewportToBottom(scrollRootRef.current);
  }, [items, visible]);

  useEffect(() => {
    if (!visible || typeof ResizeObserver === "undefined") return;
    const root = scrollRootRef.current;
    const viewport = root?.querySelector<HTMLElement>(SCROLL_VIEWPORT_SELECTOR);
    if (!viewport) return;

    // A tab switch or a side-panel/window resize can change the viewport
    // after React's message-batch layout effect has run. Keep a live feed
    // pinned in that case too; manual upward scrolling disables this path.
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

    // React's delegated scroll handler runs for every programmatic pin as
    // well as user scrolling. This listener mutates only refs, so attach it
    // directly and passively to the actual nested viewport instead.
    const updateAutoScroll = () => {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      autoScroll.current = distanceToBottom < 48;
    };
    viewport.addEventListener("scroll", updateAutoScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", updateAutoScroll);
  }, []);

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <div ref={scrollRootRef} className="min-h-0 flex-1">
        <ScrollArea className="h-full min-h-0">
          <div
            className="flex flex-col gap-0.5 px-2.5 py-2"
            style={{
              fontSize: Math.max(12, (fontSize || 16) - 4),
              fontWeight,
            }}
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
              <DanmakuRow key={line.id} event={line.event} />
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
});
