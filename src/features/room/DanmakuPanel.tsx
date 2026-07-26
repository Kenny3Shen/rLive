import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Copy, SendHorizontal } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import type { DanmakuEvent, SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createShieldMatcher, shouldShowValidatedInDanmakuPanel } from "./danmaku/filter";
import { DanmakuRichText } from "./danmaku/emoji";
import { subscribeDanmakuBatches } from "./danmaku/eventBus";
import { BoundedQueue } from "./danmaku/boundedQueue";
import {
  publishLocalPendingSubmission,
  subscribeLocalPendingSubmissions,
  type LocalPendingSubmission,
} from "./danmaku/localPendingSubmission";
import { getDanmakuSendConfig, isDanmakuSendSite } from "./danmaku/sending";
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

type DanmakuLine =
  | { id: number; source: "platform"; event: DanmakuEvent }
  | { id: number; source: "local-pending"; submission: LocalPendingSubmission };

/**
 * Normalise text before it enters the clipboard or a user-triggered repeat
 * request. The repeat action transmits this exact content; it does not append
 * a literal “+1”.
 */
export function formatDanmakuClipboardText(content: string): string {
  return content.trim();
}

/**
 * The async Clipboard API can be unavailable in older WebViews, in insecure
 * origins, or when its permission is denied. Fall back to the legacy command
 * while preserving the user's active selection and focus as much as possible.
 */
export async function copyDanmakuText(text: string): Promise<boolean> {
  if (!text || typeof document === "undefined") return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A rejected native clipboard request can still succeed through the
    // WebView-compatible fallback below.
  }

  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const activeElement = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  try {
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    try {
      textarea.remove();
    } catch {
      // The fallback is already complete or failed; cleanup should not turn
      // that outcome into an unhandled action error.
    }
    try {
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    } catch {
      // A selection can become detached while the clipboard request is open.
    }
    try {
      if (activeElement?.isConnected) activeElement.focus({ preventScroll: true });
    } catch {
      // Older WebViews may not support the focus options object.
      try {
        activeElement?.focus();
      } catch {
        // Focus restoration is best-effort only.
      }
    }
  }
}

type ActionStatus = "copied" | "copy-failed" | "submitted" | "sent" | "send-failed" | null;

function actionStatusMessage(status: ActionStatus): string | null {
  switch (status) {
    case "copied":
      return "已复制弹幕内容";
    case "copy-failed":
      return "复制失败，请手动选择内容";
    case "submitted":
      return "已提交，等待平台回显";
    case "sent":
      return "已发送相同的弹幕";
    case "send-failed":
      return "发送失败，请检查账号登录状态或直播间限制";
    default:
      return null;
  }
}

/**
 * Appending a batch keeps prior `DanmakuLine` references intact. Memoizing a
 * row therefore avoids reconciling up to 300 already-rendered messages for
 * each animation-frame flush in a busy room.
 */
const DanmakuRow = memo(function DanmakuRow({
  line,
  siteId,
  roomId,
}: {
  line: DanmakuLine;
  siteId?: SiteId;
  roomId?: string;
}) {
  if (line.source === "local-pending") {
    return <LocalPendingDanmakuRow submission={line.submission} />;
  }

  const { event } = line;
  if (event.kind === "system") {
    return (
      <div className="px-1.5 py-0.5 text-xs text-muted-foreground">
        <DanmakuRichText content={event.content} spans={event.spans} />
      </div>
    );
  }

  return <SelectableDanmakuRow event={event} siteId={siteId} roomId={roomId} />;
});

/** Local write completion is feedback, never a replacement for a chat echo. */
const LocalPendingDanmakuRow = memo(function LocalPendingDanmakuRow({
  submission,
}: {
  submission: LocalPendingSubmission;
}) {
  return (
    <div className="rounded-md border border-border-subtle bg-muted/40 px-1.5 py-1 leading-relaxed">
      <span className="mr-1.5 font-medium text-primary">我：</span>
      <DanmakuRichText content={submission.content} className="text-foreground/90" />
      <Badge className="ml-1.5 align-middle">
        本地已提交，待平台回显
      </Badge>
    </div>
  );
});

/**
 * This state intentionally lives below the memoized list row. Opening one
 * action menu therefore never invalidates the high-frequency parent list or
 * its other 299 rendered messages.
 */
const SelectableDanmakuRow = memo(function SelectableDanmakuRow({
  event,
  siteId,
  roomId,
}: {
  event: DanmakuEvent;
  siteId?: SiteId;
  roomId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus>(null);
  const [sending, setSending] = useState(false);
  const message = formatDanmakuClipboardText(event.content);
  const user = event.user.trim() || "匿名";
  const sendConfig = getDanmakuSendConfig(siteId);
  const danmakuSendEnabled = useSettingsStore((s) => s.danmakuSendEnabled);
  const danmakuSendPending = useSettingsStore((s) => s.danmakuSendPending);
  const canRepeat =
    event.kind === "chat" &&
    Boolean(sendConfig && roomId && danmakuSendEnabled && !danmakuSendPending);
  const repeatUnavailableLabel = !sendConfig
    ? "当前平台暂不支持发送弹幕"
    : danmakuSendPending
      ? "正在同步发送权限…"
    : !danmakuSendEnabled
      ? "请先在账号设置启用发送功能"
      : "发送相同的弹幕（+1）";
  const statusMessage = actionStatusMessage(actionStatus);
  const actionFailed = actionStatus === "copy-failed" || actionStatus === "send-failed";

  if (!message) {
    return (
      <div className="rounded-md px-1.5 py-1 leading-relaxed">
        <span
          className="mr-1.5 font-medium text-primary"
          style={event.color ? { color: event.color } : undefined}
        >
          {user}：
        </span>
        <DanmakuRichText
          content={event.content}
          spans={event.spans}
          className="text-foreground/90"
        />
      </div>
    );
  }

  async function copy() {
    const copied = await copyDanmakuText(message);
    setActionStatus(copied ? "copied" : "copy-failed");
  }

  async function repeat() {
    if (!sendConfig || !roomId || sending) return;
    setSending(true);
    setActionStatus(null);
    try {
      await invokeCmd<void>(sendConfig.sendCommand, { roomId, message });
      if (isDanmakuSendSite(siteId)) {
        publishLocalPendingSubmission({ siteId, roomId, content: message });
        setActionStatus("submitted");
      } else {
        setActionStatus("sent");
      }
    } catch {
      setActionStatus("send-failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setActionStatus(null);
      }}
    >
      <PopoverTrigger
        type="button"
        aria-label={`选择 ${user} 的弹幕`}
        className="block w-full cursor-pointer appearance-none rounded-md border-0 bg-transparent px-1.5 py-1 text-left leading-relaxed text-foreground outline-none transition-colors hover:bg-muted/50 aria-expanded:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          className="mr-1.5 font-medium text-primary"
          style={event.color ? { color: event.color } : undefined}
        >
          {user}：
        </span>
        <DanmakuRichText
          content={event.content}
          spans={event.spans}
          className="text-foreground/90"
        />
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        className="w-36 p-1"
      >
        <div className="flex flex-col items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="复制弹幕"
            title="复制弹幕"
            onClick={() => void copy()}
          >
            <Copy aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!canRepeat || sending}
            aria-label={canRepeat ? "发送相同的弹幕（+1）" : repeatUnavailableLabel}
            title={canRepeat ? "发送相同的弹幕（+1）" : repeatUnavailableLabel}
            onClick={() => void repeat()}
          >
            <SendHorizontal aria-hidden />
          </Button>
        </div>
        {statusMessage && (
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "px-1 py-1 text-center text-xs leading-snug",
              actionFailed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {statusMessage}
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
  /** Keep collecting while another room-side tab is open, without repainting it. */
  visible?: boolean;
  className?: string;
  statusText?: string | null;
};

export const DanmakuPanel = memo(function DanmakuPanel({
  active,
  siteId,
  roomId,
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
        accepted.push({ id: ++nextIdRef.current, source: "platform", event: message });
      }

      pending.pushAll(accepted);
      if (accepted.length === 0) return;
      scheduleFlush();
    });
    const unsubscribeLocalPending = subscribeLocalPendingSubmissions(siteId, roomId, (submission) => {
      if (!activeRef.current) return;
      // Local submission feedback is intentionally independent of the
      // viewer's shield-word preferences and has its own visible marker.
      pending.push({ id: ++nextIdRef.current, source: "local-pending", submission });
      scheduleFlush();
    });

    return () => {
      unsubscribe();
      unsubscribeLocalPending();
      cancelFlush();
      if (scheduleFlushRef.current === scheduleFlush) scheduleFlushRef.current = () => {};
      pending.clear();
    };
  }, [active, roomId, siteId]);

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
              <DanmakuRow key={line.id} line={line} siteId={siteId} roomId={roomId} />
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
});
