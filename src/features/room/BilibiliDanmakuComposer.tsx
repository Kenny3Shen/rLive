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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { BILIBILI_NATIVE_TEXT_EMOJIS, DANMAKU_EMOJIS } from "./danmaku/emoji";
import { insertBilibiliDanmakuText } from "./danmaku/outgoing";
import { getDanmakuSendConfig, type DanmakuSendStatus } from "./danmaku/sending";

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: string }).message);
  }
  return "发送失败，请稍后重试";
}

function truncateUtf16(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

function insertPlainDanmakuText(
  draft: string,
  text: string,
  start: number,
  end: number,
  maxLength: number,
): { draft: string; caret: number } {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const next = truncateUtf16(`${before}${text}${after}`, maxLength);
  return { draft: next, caret: Math.min(before.length + text.length, next.length) };
}

type DanmakuComposerProps = {
  siteId?: SiteId;
  roomId?: string;
  /** Compact transparent variant for the player-overlay control bar. */
  overlay?: boolean;
  /** Keeps the player chrome visible while the emoji picker is open. */
  onOverlayInteractionChange?: (open: boolean) => void;
};

/**
 * One intentionally small, user-operated composer for platforms with a
 * verified local send endpoint. It never creates an optimistic chat row; the
 * live websocket remains responsible for displaying the server echo.
 */
export function DanmakuComposer({
  siteId,
  roomId,
  overlay = false,
  onOverlayInteractionChange,
}: DanmakuComposerProps) {
  const bilibiliSendEnabled = useSettingsStore((s) => s.bilibiliDanmakuSendEnabled);
  const bilibiliSendSettingPending = useSettingsStore((s) => s.bilibiliDanmakuSendPending);
  const bilibiliCookieRevision = useSettingsStore((s) => s.bilibiliCookieRevision);
  const sendConfig = getDanmakuSendConfig(siteId);
  const [availability, setAvailability] = useState<DanmakuSendStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendInFlightRef = useRef(false);
  const emojiPickerTitleId = useId();

  useEffect(() => {
    if (!sendConfig || !roomId) return;
    let cancelled = false;
    setAvailability(null);
    // Do not ask the backend while the explicit sending permission is still
    // queued for persistence. Once it settles this effect runs again,
    // preventing a stale disabled status from pinning the composer until the
    // user re-enters.
    if (siteId === "bilibili" && bilibiliSendSettingPending) {
      setAvailability({
        send_enabled: bilibiliSendEnabled,
        cookie_ready: false,
        available: false,
        message: "正在同步发送权限…",
      });
      return () => {
        cancelled = true;
      };
    }
    void invokeCmd<DanmakuSendStatus>(sendConfig.statusCommand)
      .then((status) => {
        if (!cancelled) setAvailability(status);
      })
      .catch(() => {
        if (!cancelled) {
          setAvailability({
            send_enabled: false,
            cookie_ready: false,
            available: false,
            message: `暂时无法确认${sendConfig.siteLabel}发送权限`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    siteId,
    roomId,
    sendConfig,
    bilibiliSendEnabled,
    bilibiliSendSettingPending,
    bilibiliCookieRevision,
  ]);

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

  if (!sendConfig || !roomId) return null;

  const config = sendConfig;
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
    const { draft: nextDraft, caret } = config.supportsNativeBilibiliEmoji
      ? insertBilibiliDanmakuText(draft, text, start, end)
      : insertPlainDanmakuText(draft, text, start, end, config.maxLength);

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
      await invokeCmd<void>(config.sendCommand, {
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
            "border-white/25 bg-black/30 text-white has-[[data-slot=input-group-control]:focus-visible]:border-white/70 has-[[data-slot=input-group-control]:focus-visible]:ring-white/30 has-[>input:disabled]:bg-black/20",
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
                  aria-label={`选择${config.siteLabel}表情`}
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
                选择表情
              </PopoverTitle>
              {config.supportsNativeBilibiliEmoji ? (
                <Tabs defaultValue="bilibili" className="gap-1">
                  <TabsList
                    variant="line"
                    aria-label="表情分类"
                    className={cn(
                      "h-7 w-full justify-start border-b border-border-subtle px-0",
                      overlay && "border-white/15 text-white/70",
                    )}
                  >
                    <TabsTrigger
                      value="bilibili"
                      className={cn(
                        "h-7 px-2 text-xs",
                        overlay &&
                          "text-white/70 hover:text-white data-active:text-white after:bg-white",
                      )}
                    >
                      B站表情
                    </TabsTrigger>
                    <TabsTrigger
                      value="emoji"
                      className={cn(
                        "h-7 px-2 text-xs",
                        overlay &&
                          "text-white/70 hover:text-white data-active:text-white after:bg-white",
                      )}
                    >
                      Emoji
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="bilibili" className="mt-0 data-[hidden]:hidden">
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
                            aria-label={`插入 B站表情 ${emoji}`}
                            title={emoji}
                            onClick={() => insertEmoji(emoji)}
                          >
                            {emoji}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </TabsContent>
                  <TabsContent value="emoji" className="mt-0 data-[hidden]:hidden">
                    <DanmakuEmojiGrid overlay={overlay} onSelect={insertEmoji} />
                  </TabsContent>
                </Tabs>
              ) : (
                <DanmakuEmojiGrid overlay={overlay} onSelect={insertEmoji} />
              )}
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
          maxLength={config.maxLength}
          aria-label={`${config.siteLabel}弹幕内容`}
          className={cn("min-w-0 text-sm", overlay && "text-white placeholder:text-white/60")}
        />
        <InputGroupAddon align="inline-end" className="py-0">
          <InputGroupButton
            type="button"
            variant="default"
            size="icon-sm"
            disabled={!canSubmit}
            onClick={() => void send()}
            aria-label={`发送${config.siteLabel}弹幕`}
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

function DanmakuEmojiGrid({
  overlay,
  onSelect,
}: {
  overlay: boolean;
  onSelect: (emoji: string) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {DANMAKU_EMOJIS.map((emoji) => (
        <Button
          key={emoji.id}
          type="button"
          variant="ghost"
          size="icon"
          className={cn("size-12", overlay && "hover:bg-white/15 focus-visible:ring-white/70")}
          aria-label={`插入 Emoji ${emoji.label}`}
          title={emoji.label}
          onClick={() => onSelect(emoji.text)}
        >
          <img src={emoji.src} alt="" draggable={false} className="size-7 object-contain" />
        </Button>
      ))}
    </div>
  );
}

/** @deprecated Use {@link DanmakuComposer}. Kept for external room extensions. */
export const BilibiliDanmakuComposer = DanmakuComposer;
