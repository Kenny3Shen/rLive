import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  createRepeatMatcher,
  createShieldMatcher,
  shouldShowInDanmakuPanel,
} from "./danmaku/filter";
import { DanmakuEmojiText } from "./danmaku/emoji";
import { cn } from "@/lib/utils";

const MAX = 400;
const MAX_BUFFERED = 200;
const MAX_PER_FRAME = 50;
const SCROLL_VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

function scrollDanmakuViewportToBottom(root: HTMLElement | null): void {
  const viewport = root?.querySelector<HTMLElement>(SCROLL_VIEWPORT_SELECTOR);
  if (viewport) viewport.scrollTop = viewport.scrollHeight;
}

type DanmakuLine = {
  id: number;
  event: DanmakuEvent;
};

/**
 * Appending a batch keeps prior `DanmakuLine` references intact. Memoizing a
 * row therefore avoids reconciling up to 400 already-rendered messages for
 * each animation-frame flush in a busy room.
 */
const DanmakuRow = memo(function DanmakuRow({ line }: { line: DanmakuLine }) {
  const event = line.event;
  if (event.kind === "system") {
    return (
      <div className="px-1.5 py-0.5 text-xs text-muted-foreground">
        <DanmakuEmojiText content={event.content} />
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
      <DanmakuEmojiText content={event.content} className="text-foreground/90" />
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

export function DanmakuPanel({ active, visible = true, className, statusText }: DanmakuPanelProps) {
  const [items, setItems] = useState<DanmakuLine[]>([]);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const pendingRef = useRef<DanmakuLine[]>([]);
  const flushFrameRef = useRef<number | null>(null);
  const scheduleFlushRef = useRef<() => void>(() => {});
  const nextIdRef = useRef(0);
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const filterRepeats = useSettingsStore((s) => s.danmakuFilterRepeats);
  const filterGifts = useSettingsStore((s) => s.danmakuFilterGifts);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);
  const fontWeight = useSettingsStore((s) => s.danmakuFontWeight);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
  const repeatMatcher = useMemo(() => createRepeatMatcher(filterRepeats), [filterRepeats]);
  const matchersRef = useRef({ shieldMatcher, repeatMatcher, filterGifts });

  // The event subscription stays stable while a setting changes. Besides
  // avoiding a short listener gap, this preserves the bounded hidden-tab
  // queue and the repeat filter's history.
  useLayoutEffect(() => {
    matchersRef.current = { shieldMatcher, repeatMatcher, filterGifts };
  }, [shieldMatcher, repeatMatcher, filterGifts]);

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
    if (!active) {
      if (flushFrameRef.current !== null) {
        cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
      pendingRef.current = [];
      nextIdRef.current = 0;
      autoScroll.current = true;
      setItems([]);
      return;
    }

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const flush = () => {
      flushFrameRef.current = null;
      // `keepMounted` makes tab changes preserve the current message list.
      // Hold new events in the bounded queue while this panel is hidden so
      // chat traffic cannot reconcile hundreds of invisible React nodes.
      if (!activeRef.current || !visibleRef.current) return;
      const batch = pendingRef.current.splice(0, MAX_PER_FRAME);
      if (batch.length === 0) return;

      setItems((previous) => {
        const next = previous.concat(batch);
        return next.length > MAX ? next.slice(next.length - MAX) : next;
      });

      // A burst should not make one animation frame reconcile hundreds of
      // nodes. Remaining recent messages drain over following frames.
      if (pendingRef.current.length > 0) scheduleFlush();
    };

    const scheduleFlush = () => {
      if (activeRef.current && visibleRef.current && flushFrameRef.current === null) {
        flushFrameRef.current = requestAnimationFrame(flush);
      }
    };
    scheduleFlushRef.current = scheduleFlush;

    void listen<DanmakuEvent>("danmaku", (event) => {
      if (cancelled || !activeRef.current) return;
      const msg = event.payload;
      const {
        shieldMatcher: currentShieldMatcher,
        repeatMatcher: currentRepeatMatcher,
        filterGifts: currentFilterGifts,
      } = matchersRef.current;
      if (!shouldShowInDanmakuPanel(msg, currentFilterGifts)) return;
      if (currentShieldMatcher(msg)) return;
      if (currentRepeatMatcher(msg)) return;

      const pending = pendingRef.current;
      pending.push({ id: ++nextIdRef.current, event: msg });
      if (pending.length > MAX_BUFFERED) {
        pending.splice(0, pending.length - MAX_BUFFERED);
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
      if (flushFrameRef.current !== null) {
        cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
      if (scheduleFlushRef.current === scheduleFlush) scheduleFlushRef.current = () => {};
      pendingRef.current = [];
    };
  }, [active]);

  useLayoutEffect(() => {
    if (!visible || !autoScroll.current) return;

    // Base UI owns a nested viewport, so scrolling a sentinel with
    // `scrollIntoView` can select an outer ancestor instead of the chat
    // viewport. Set the actual viewport position directly and repeat on the
    // next frame after its scrollbar has measured the new batch.
    const scrollToBottom = () => {
      if (!autoScroll.current) return;
      scrollDanmakuViewportToBottom(scrollRootRef.current);
    };

    scrollToBottom();
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
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

  function onViewportScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScroll.current = dist < 48;
  }

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <div ref={scrollRootRef} className="min-h-0 flex-1">
        <ScrollArea className="h-full min-h-0" onScrollCapture={onViewportScroll}>
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
              <DanmakuRow key={line.id} line={line} />
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
