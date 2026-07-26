import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SendHorizontal, SmilePlus } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { SiteId } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { DANMAKU_EMOJIS } from "./danmaku/emoji";

type SendStatus = {
  send_enabled: boolean;
  cookie_ready: boolean;
  available: boolean;
  message: string;
};

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: string }).message);
  }
  return "发送失败，请稍后重试";
}

type BilibiliDanmakuComposerProps = {
  siteId?: SiteId;
  roomId?: string;
  /** Compact transparent variant for the player-overlay control bar. */
  overlay?: boolean;
  /** Keeps the player chrome visible while the emoji picker is open. */
  onOverlayInteractionChange?: (open: boolean) => void;
};

/**
 * Deliberately narrow Bilibili-only composer. It never creates a local chat
 * row; the live websocket remains responsible for showing the server echo.
 */
export function BilibiliDanmakuComposer({
  siteId,
  roomId,
  overlay = false,
  onOverlayInteractionChange,
}: BilibiliDanmakuComposerProps) {
  const sendEnabled = useSettingsStore((s) => s.bilibiliDanmakuSendEnabled);
  const sendSettingPending = useSettingsStore((s) => s.bilibiliDanmakuSendPending);
  const bilibiliCookieRevision = useSettingsStore((s) => s.bilibiliCookieRevision);
  const [availability, setAvailability] = useState<SendStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendInFlightRef = useRef(false);

  useEffect(() => {
    if (siteId !== "bilibili") return;
    let cancelled = false;
    setAvailability(null);
    // Do not ask the backend while the explicit sending permission is still
    // queued for persistence. Once it settles this effect runs again,
    // preventing a stale disabled status from pinning the composer until the
    // user re-enters.
    if (sendSettingPending) {
      setAvailability({
        send_enabled: sendEnabled,
        cookie_ready: false,
        available: false,
        message: "正在同步发送权限…",
      });
      return () => {
        cancelled = true;
      };
    }
    void invokeCmd<SendStatus>("bilibili_danmaku_send_status")
      .then((status) => {
        if (!cancelled) setAvailability(status);
      })
      .catch(() => {
        if (!cancelled) {
          setAvailability({
            send_enabled: false,
            cookie_ready: false,
            available: false,
            message: "暂时无法确认 B站发送权限",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [siteId, roomId, sendEnabled, sendSettingPending, bilibiliCookieRevision]);

  const overlayOpen = emojiOpen;
  useEffect(() => {
    onOverlayInteractionChange?.(overlayOpen);
  }, [onOverlayInteractionChange, overlayOpen]);

  useEffect(
    () => () => {
      onOverlayInteractionChange?.(false);
    },
    [onOverlayInteractionChange],
  );

  if (siteId !== "bilibili" || !roomId) return null;

  const ready = availability?.available === true;
  const canSubmit = ready && draft.trim().length > 0 && !sending;
  const statusText = result ?? availability?.message ?? "正在检查发送权限…";

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.repeat) return;
    event.preventDefault();
    void send();
  }

  function insertEmoji(text: string) {
    if (!ready || sending) return;
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    const nextDraft = `${draft.slice(0, start)}${text}${draft.slice(end)}`.slice(0, 80);
    const caret = Math.min(start + text.length, nextDraft.length);

    setDraft(nextDraft);
    setEmojiOpen(false);
    window.requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(caret, caret);
    });
  }

  async function send() {
    // State updates are asynchronous, so a ref closes the tiny gap in which
    // repeated Enter/click events could otherwise submit the same draft twice.
    if (!canSubmit || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setResult(null);
    try {
      await invokeCmd<void>("bilibili_danmaku_send", {
        roomId,
        message: draft.trim(),
      });
      setDraft("");
      setResult("已提交，等待直播间回显。");
    } catch (error) {
      setResult(`发送失败：${errorMessage(error)}`);
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  return (
    <div
      className={cn(
        "min-w-0",
        overlay
          ? "w-full max-w-xl"
          : "shrink-0 border-t border-border-subtle bg-sidebar/80 px-2.5 py-2",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={availability?.message ?? "正在检查发送权限…"}
          disabled={!ready || sending}
          maxLength={80}
          aria-label="B站弹幕内容"
          className={cn(
            "h-8 min-w-0 text-sm",
            overlay &&
              "border-white/25 bg-black/30 text-white placeholder:text-white/60 focus-visible:border-white/70 focus-visible:ring-white/30 disabled:bg-black/20 dark:bg-black/30",
            result?.startsWith("发送失败") && "border-destructive/80",
          )}
        />
        <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!ready || sending}
                aria-label="选择表情"
                className={cn(
                  overlay &&
                    "text-white hover:bg-white/15 hover:text-white aria-expanded:bg-white/15 aria-expanded:text-white focus-visible:ring-white/70",
                )}
              />
            }
          >
            <SmilePlus aria-hidden />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            className={cn(
              "w-[13.5rem] gap-1.5 p-2",
              overlay && "border-white/10 bg-black/90 text-white shadow-xl backdrop-blur-md",
            )}
          >
            <p
              className={cn("px-0.5 text-xs", overlay ? "text-white/70" : "text-muted-foreground")}
            >
              选择表情
            </p>
            <div className="grid grid-cols-4 gap-1" role="grid" aria-label="弹幕表情">
              {DANMAKU_EMOJIS.map((emoji) => (
                <Button
                  key={emoji.id}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "size-9 p-1",
                    overlay && "hover:bg-white/15 focus-visible:ring-white/70",
                  )}
                  aria-label={`插入${emoji.label}表情`}
                  onClick={() => insertEmoji(emoji.text)}
                >
                  <img src={emoji.src} alt="" draggable={false} className="size-7 object-contain" />
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          size="icon"
          disabled={!canSubmit}
          onClick={() => void send()}
          aria-label="发送 B站弹幕"
          className={cn(
            overlay && "bg-white/90 text-black hover:bg-white focus-visible:ring-white/70",
          )}
        >
          <SendHorizontal />
        </Button>
      </div>
      {overlay ? (
        <p
          className={cn(
            "mt-1 truncate text-center text-[11px] leading-4",
            result?.startsWith("发送失败") ? "text-red-200" : "text-white/75",
          )}
          role="status"
          aria-live="polite"
        >
          {statusText}
        </p>
      ) : (
        <p
          className={cn(
            "mt-1.5 min-h-4 text-[11px] leading-4",
            result?.startsWith("发送失败") ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {statusText}
        </p>
      )}
    </div>
  );
}
