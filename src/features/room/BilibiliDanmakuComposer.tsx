import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { SendHorizontal, SmilePlus } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { SiteId } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BILIBILI_NATIVE_TEXT_EMOJIS } from "./danmaku/emoji";

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
  const emojiPickerTitleId = useId();

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
  const inputPlaceholder = ready ? (result ?? "输入弹幕…") : statusText;

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
      <InputGroup
        className={cn(
          "h-8 min-w-0",
          overlay &&
            "border-white/25 bg-black/30 text-white has-[[data-slot=input-group-control]:focus-visible]:border-white/70 has-[[data-slot=input-group-control]:focus-visible]:ring-white/30 has-[>input:disabled]:bg-black/20 dark:bg-black/30",
          result?.startsWith("发送失败") && "border-destructive/80",
        )}
      >
        <InputGroupAddon align="inline-start" className="py-0">
          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger
              render={
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  disabled={!ready || sending}
                  aria-label="选择 B站原生表情"
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
              align="start"
              aria-labelledby={emojiPickerTitleId}
              className={cn(
                "w-80 gap-2 p-2",
                overlay && "border-white/10 bg-black/90 text-white shadow-xl backdrop-blur-md",
              )}
            >
              <PopoverTitle
                id={emojiPickerTitleId}
                className={cn(
                  "px-0.5 text-xs",
                  overlay ? "text-white/70" : "text-muted-foreground",
                )}
              >
                B站原生表情
              </PopoverTitle>
              <div className="max-h-60 overflow-y-auto pr-1">
                <div className="grid grid-cols-2 gap-1">
                  {BILIBILI_NATIVE_TEXT_EMOJIS.map((emoji) => (
                    <Button
                      key={emoji}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "min-w-0 justify-center truncate px-1 font-mono text-[11px]",
                        overlay && "hover:bg-white/15 focus-visible:ring-white/70",
                      )}
                      aria-label={`插入 B站原生表情 ${emoji}`}
                      title={emoji}
                      onClick={() => insertEmoji(emoji)}
                    >
                      {emoji}
                    </Button>
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setResult(null);
          }}
          onKeyDown={onInputKeyDown}
          placeholder={inputPlaceholder}
          disabled={!ready || sending}
          maxLength={80}
          aria-label="B站弹幕内容"
          className={cn("min-w-0 text-sm", overlay && "text-white placeholder:text-white/60")}
        />
        <InputGroupAddon align="inline-end" className="py-0">
          <InputGroupButton
            type="button"
            variant="default"
            size="icon-sm"
            disabled={!canSubmit}
            onClick={() => void send()}
            aria-label="发送 B站弹幕"
            className={cn(
              overlay && "bg-white/90 text-black hover:bg-white focus-visible:ring-white/70",
            )}
          >
            <SendHorizontal />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <span className="sr-only" role="status" aria-live="polite">
        {statusText}
      </span>
    </div>
  );
}
