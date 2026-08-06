import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SendHorizontal, SmilePlus, Star, Trash2 } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { DanmakuFavoriteItem, DanmakuSendHistoryItem, SiteId } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { BILIBILI_NATIVE_TEXT_EMOJIS, DANMAKU_EMOJIS } from "./danmaku/emoji";
import { insertBilibiliDanmakuText } from "./danmaku/outgoing";
import {
  getDanmakuSendConfig,
  isDanmakuSendSite,
  type DanmakuSendSiteId,
  type DanmakuSendStatus,
} from "./danmaku/sending";

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

type DanmakuPickerTab = "emoji" | "favorites" | "history";

/**
 * The quick picker and the send button flank the same input. Sharing one
 * geometry keeps the group symmetric, and staying a step under the group's
 * 2rem height keeps either button from touching its border.
 */
const COMPOSER_BUTTON_CLASS = "size-7 rounded-md transition-colors";
/** Matches the transparent player chrome the overlay composer sits in. */
const COMPOSER_OVERLAY_GHOST_CLASS =
  "text-white/90 hover:bg-white/15 hover:text-white aria-expanded:bg-white/15 aria-expanded:text-white focus-visible:ring-white/70";

type DanmakuQuickPickerProps = {
  siteId: DanmakuSendSiteId;
  siteLabel: string;
  supportsNativeBilibiliEmoji: boolean;
  disabled: boolean;
  overlay: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: string;
  onSelectEmoji: (emoji: string) => void;
  onSelectMessage: (content: string) => void;
};

function isDanmakuPickerTab(value: unknown): value is DanmakuPickerTab {
  return value === "emoji" || value === "favorites" || value === "history";
}

function DanmakuQuickPicker({
  siteId,
  siteLabel,
  supportsNativeBilibiliEmoji,
  disabled,
  overlay,
  open,
  onOpenChange,
  draft,
  onSelectEmoji,
  onSelectMessage,
}: DanmakuQuickPickerProps) {
  const [activeTab, setActiveTab] = useState<DanmakuPickerTab>("emoji");
  const [favoriteAction, setFavoriteAction] = useState<string | null>(null);
  const [favoriteFailed, setFavoriteFailed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  const queryClient = useQueryClient();
  const favoriteQueryKey = ["danmaku-favorites", siteId] as const;
  const historyQueryKey = ["danmaku-send-history", siteId] as const;
  const favoriteQuery = useQuery({
    queryKey: favoriteQueryKey,
    queryFn: () =>
      invokeCmd<DanmakuFavoriteItem[]>("danmaku_favorite_list", {
        siteId,
      }),
    enabled: open && (activeTab === "favorites" || activeTab === "history"),
  });
  const historyQuery = useQuery({
    queryKey: historyQueryKey,
    queryFn: () =>
      invokeCmd<DanmakuSendHistoryItem[]>("danmaku_send_history_list", {
        siteId,
      }),
    enabled: open && activeTab === "history",
  });
  const favoriteItems = favoriteQuery.data ?? [];
  const historyItems = historyQuery.data ?? [];
  const favoriteContents = new Set(favoriteItems.map((item) => item.content));
  const favoriteDraft = draft.trim();
  const favoriteBusy = favoriteAction !== null;

  useEffect(() => {
    if (open) return;
    setFavoriteFailed(false);
    setClearFailed(false);
  }, [open]);

  function selectStoredMessage(content: string) {
    onSelectMessage(content);
    onOpenChange(false);
  }

  async function addFavorite(content: string) {
    const normalized = content.trim();
    if (!normalized || favoriteBusy) return;
    setFavoriteAction(normalized);
    setFavoriteFailed(false);
    try {
      await invokeCmd<void>("danmaku_favorite_add", {
        siteId,
        content: normalized,
      });
      queryClient.setQueryData<DanmakuFavoriteItem[]>(favoriteQueryKey, (current) => [
        { site_id: siteId, content: normalized, added_at: Date.now() },
        ...(current ?? []).filter((item) => item.content !== normalized),
      ]);
      void queryClient.invalidateQueries({ queryKey: favoriteQueryKey });
    } catch {
      setFavoriteFailed(true);
    } finally {
      setFavoriteAction(null);
    }
  }

  async function removeFavorite(content: string) {
    if (favoriteBusy) return;
    setFavoriteAction(content);
    setFavoriteFailed(false);
    try {
      await invokeCmd<void>("danmaku_favorite_remove", { siteId, content });
      queryClient.setQueryData<DanmakuFavoriteItem[]>(favoriteQueryKey, (current) =>
        current?.filter((item) => item.content !== content),
      );
      void queryClient.invalidateQueries({ queryKey: favoriteQueryKey });
    } catch {
      setFavoriteFailed(true);
    } finally {
      setFavoriteAction(null);
    }
  }

  async function clearHistory() {
    if (clearing || historyItems.length === 0) return;
    setClearing(true);
    setClearFailed(false);
    try {
      await queryClient.cancelQueries({ queryKey: historyQueryKey });
      await invokeCmd<void>("danmaku_send_history_clear", { siteId });
      queryClient.setQueryData<DanmakuSendHistoryItem[]>(historyQueryKey, []);
      void queryClient.invalidateQueries({ queryKey: historyQueryKey });
      void queryClient.invalidateQueries({ queryKey: ["danmaku-send-history", "all"] });
    } catch {
      setClearFailed(true);
      void queryClient.invalidateQueries({ queryKey: historyQueryKey });
    } finally {
      setClearing(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <InputGroupButton
            type="button"
            size="icon-sm"
            disabled={disabled}
            aria-label={`打开${siteLabel}快捷弹幕面板`}
            title="表情、收藏和发送历史"
            className={cn(
              COMPOSER_BUTTON_CLASS,
              overlay ? COMPOSER_OVERLAY_GHOST_CLASS : "text-muted-foreground hover:text-foreground",
            )}
          />
        }
      >
        <SmilePlus aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label={`${siteLabel}快捷弹幕面板`}
        className={cn(
          "w-80 max-h-(--available-height) max-w-(--available-width) overflow-x-hidden overflow-y-auto overscroll-contain gap-2 p-2",
          overlay && "border-white/10 bg-black/90 text-white shadow-xl backdrop-blur-md",
        )}
      >
        <PopoverTitle
          className={cn("px-0.5 text-xs", overlay ? "text-white/70" : "text-muted-foreground")}
        >
          快捷弹幕
        </PopoverTitle>
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            if (isDanmakuPickerTab(value)) setActiveTab(value);
          }}
          className="gap-1"
        >
          <TabsList
            variant="line"
            aria-label="快捷弹幕分类"
            className={cn(
              "h-7 w-full justify-start border-b border-border-subtle px-0",
              overlay && "border-white/15 text-white/70",
            )}
          >
            <TabsTrigger
              value="emoji"
              className={cn(
                "h-7 px-2 text-xs",
                overlay && "text-white/70 hover:text-white data-active:text-white after:bg-white",
              )}
            >
              表情
            </TabsTrigger>
            <TabsTrigger
              value="favorites"
              className={cn(
                "h-7 px-2 text-xs",
                overlay && "text-white/70 hover:text-white data-active:text-white after:bg-white",
              )}
            >
              收藏
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className={cn(
                "h-7 px-2 text-xs",
                overlay && "text-white/70 hover:text-white data-active:text-white after:bg-white",
              )}
            >
              历史
            </TabsTrigger>
          </TabsList>

          <TabsContent value="emoji" className="mt-0 data-[hidden]:hidden">
            {supportsNativeBilibiliEmoji ? (
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
                  <div className="max-h-[min(15rem,max(0px,calc(var(--available-height)-6rem)))] overflow-y-auto pr-1">
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
                          onClick={() => onSelectEmoji(emoji)}
                        >
                          {emoji}
                        </Button>
                      ))}
                    </div>
                  </div>
                </TabsContent>
                <TabsContent value="emoji" className="mt-0 data-[hidden]:hidden">
                  <DanmakuEmojiGrid overlay={overlay} onSelect={onSelectEmoji} />
                </TabsContent>
              </Tabs>
            ) : (
              <DanmakuEmojiGrid overlay={overlay} onSelect={onSelectEmoji} />
            )}
          </TabsContent>

          <TabsContent value="favorites" className="mt-0 data-[hidden]:hidden">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <span className={cn("text-xs", overlay ? "text-white/70" : "text-muted-foreground")}>
                收藏弹幕
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled || favoriteBusy || favoriteDraft.length === 0}
                title={favoriteDraft.length > 0 ? "收藏当前输入的弹幕" : "先输入要收藏的弹幕"}
                onClick={() => void addFavorite(favoriteDraft)}
                className={cn(
                  "text-muted-foreground",
                  overlay &&
                    "text-white/70 hover:bg-white/15 hover:text-white focus-visible:ring-white/70",
                )}
              >
                {favoriteAction === favoriteDraft ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Star data-icon="inline-start" />
                )}
                收藏当前
              </Button>
            </div>
            {favoriteQuery.isFetching && favoriteItems.length === 0 && (
              <p
                className={cn(
                  "flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground",
                  overlay && "text-white/70",
                )}
                role="status"
              >
                <Spinner aria-hidden />
                正在加载收藏…
              </p>
            )}
            {favoriteQuery.isError && favoriteItems.length === 0 && (
              <div className="flex items-center justify-between gap-2 px-1 py-2 text-xs text-destructive">
                <span>收藏加载失败</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void favoriteQuery.refetch()}
                  className={cn(overlay && "text-white hover:bg-white/15")}
                >
                  重试
                </Button>
              </div>
            )}
            {!favoriteQuery.isFetching && !favoriteQuery.isError && favoriteItems.length === 0 && (
              <p
                className={cn(
                  "px-1 py-2 text-xs text-muted-foreground",
                  overlay && "text-white/70",
                )}
              >
                暂无收藏弹幕
              </p>
            )}
            {favoriteItems.length > 0 && (
              <ScrollArea className="h-52 max-h-[max(0px,calc(var(--available-height)-6rem))] pr-0.5">
                <div className="flex flex-col gap-0.5">
                  {favoriteItems.map((item) => (
                    <div key={item.content} className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "h-8 min-w-0 flex-1 justify-start truncate px-2 text-left text-sm font-normal",
                          overlay &&
                            "hover:bg-white/15 hover:text-white focus-visible:ring-white/70",
                        )}
                        title={item.content}
                        onClick={() => selectStoredMessage(item.content)}
                      >
                        {item.content}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={favoriteBusy}
                        aria-label={`取消收藏 ${item.content}`}
                        title="取消收藏"
                        onClick={() => void removeFavorite(item.content)}
                        className={cn(
                          "text-muted-foreground",
                          overlay &&
                            "text-white/70 hover:bg-white/15 hover:text-white focus-visible:ring-white/70",
                        )}
                      >
                        {favoriteAction === item.content ? (
                          <Spinner data-icon="inline-start" aria-hidden />
                        ) : (
                          <Trash2 data-icon="inline-start" aria-hidden />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
            {favoriteFailed && (
              <p className="px-1 text-xs text-destructive">收藏操作失败，请重试。</p>
            )}
          </TabsContent>

          <TabsContent value="history" className="mt-0 data-[hidden]:hidden">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <span className={cn("text-xs", overlay ? "text-white/70" : "text-muted-foreground")}>
                发送历史
              </span>
              {historyItems.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={clearing}
                  onClick={() => void clearHistory()}
                  className={cn(
                    "text-muted-foreground",
                    overlay &&
                      "text-white/70 hover:bg-white/15 hover:text-white focus-visible:ring-white/70",
                  )}
                >
                  {clearing ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Trash2 data-icon="inline-start" />
                  )}
                  清空
                </Button>
              )}
            </div>
            {historyQuery.isFetching && historyItems.length === 0 && (
              <p
                className={cn(
                  "flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground",
                  overlay && "text-white/70",
                )}
                role="status"
              >
                <Spinner aria-hidden />
                正在加载发送历史…
              </p>
            )}
            {historyQuery.isError && historyItems.length === 0 && (
              <div className="flex items-center justify-between gap-2 px-1 py-2 text-xs text-destructive">
                <span>发送历史加载失败</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void historyQuery.refetch()}
                  className={cn(overlay && "text-white hover:bg-white/15")}
                >
                  重试
                </Button>
              </div>
            )}
            {!historyQuery.isFetching && !historyQuery.isError && historyItems.length === 0 && (
              <p
                className={cn(
                  "px-1 py-2 text-xs text-muted-foreground",
                  overlay && "text-white/70",
                )}
              >
                暂无发送记录
              </p>
            )}
            {historyItems.length > 0 && (
              <ScrollArea className="h-52 max-h-[max(0px,calc(var(--available-height)-6rem))] pr-0.5">
                <div className="flex flex-col gap-0.5">
                  {historyItems.map((item) => {
                    const isFavorite = favoriteContents.has(item.content);
                    return (
                      <div key={item.content} className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-8 min-w-0 flex-1 justify-start truncate px-2 text-left text-sm font-normal",
                            overlay &&
                              "hover:bg-white/15 hover:text-white focus-visible:ring-white/70",
                          )}
                          title={item.content}
                          onClick={() => selectStoredMessage(item.content)}
                        >
                          {item.content}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={favoriteBusy || isFavorite}
                          aria-label={isFavorite ? "已收藏" : `收藏 ${item.content}`}
                          title={isFavorite ? "已收藏" : "收藏弹幕"}
                          onClick={() => void addFavorite(item.content)}
                          className={cn(
                            "text-muted-foreground",
                            overlay &&
                              "text-white/70 hover:bg-white/15 hover:text-white focus-visible:ring-white/70",
                          )}
                        >
                          {favoriteAction === item.content ? (
                            <Spinner data-icon="inline-start" aria-hidden />
                          ) : (
                            <Star data-icon="inline-start" aria-hidden />
                          )}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
            {favoriteFailed && (
              <p className="px-1 text-xs text-destructive">收藏操作失败，请重试。</p>
            )}
            {clearFailed && (
              <p className="px-1 text-xs text-destructive">清空发送历史失败，请重试。</p>
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One intentionally small, user-operated composer for platforms with a
 * verified local send endpoint. Platform chat is shown only when it arrives
 * through the normal live websocket stream.
 */
export function DanmakuComposer({
  siteId,
  roomId,
  overlay = false,
  onOverlayInteractionChange,
}: DanmakuComposerProps) {
  const danmakuSendEnabled = useSettingsStore((s) => s.danmakuSendEnabled);
  const danmakuSendPending = useSettingsStore((s) => s.danmakuSendPending);
  const danmakuCookieRevision = useSettingsStore((s) => s.danmakuCookieRevision);
  const sendConfig = getDanmakuSendConfig(siteId);
  const [availability, setAvailability] = useState<DanmakuSendStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [quickPickerOpen, setQuickPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendInFlightRef = useRef(false);

  useEffect(() => {
    if (!sendConfig || !roomId) return;
    let cancelled = false;
    setAvailability(null);
    // Do not ask the backend while the explicit sending permission is still
    // queued for persistence. Once it settles this effect runs again,
    // preventing a stale disabled status from pinning the composer until the
    // user re-enters.
    if (danmakuSendPending) {
      setAvailability({
        send_enabled: danmakuSendEnabled,
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
  }, [siteId, roomId, sendConfig, danmakuSendEnabled, danmakuSendPending, danmakuCookieRevision]);

  const overlayOpen = quickPickerOpen;
  useEffect(() => {
    onOverlayInteractionChange?.(overlayOpen);
  }, [onOverlayInteractionChange, overlayOpen]);

  useEffect(
    () => () => {
      onOverlayInteractionChange?.(false);
    },
    [onOverlayInteractionChange],
  );

  if (!sendConfig || !roomId || !isDanmakuSendSite(siteId)) return null;

  const config = sendConfig;
  // Keep the narrowed room identity stable for async send callbacks. React
  // may render a different room while an earlier request is still in flight.
  const currentRoomId = roomId;
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
    setQuickPickerOpen(false);
    window.requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(caret, caret);
    });
  }

  function selectStoredDanmaku(content: string) {
    if (!ready || sending) return;
    const nextDraft = truncateUtf16(content, config.maxLength);
    setDraft(nextDraft);
    setResult(null);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(nextDraft.length, nextDraft.length);
    });
  }

  async function send() {
    // State updates are asynchronous, so a ref closes the tiny gap in which
    // repeated Enter/click events could otherwise submit the same draft twice.
    if (!canSubmit || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setResult(null);
    const outgoingMessage = draft.trim();
    try {
      await invokeCmd<void>(config.sendCommand, {
        roomId: currentRoomId,
        message: outgoingMessage,
      });
      setDraft("");
      setResult("发送请求已提交。");
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
          <DanmakuQuickPicker
            siteId={siteId}
            siteLabel={config.siteLabel}
            supportsNativeBilibiliEmoji={config.supportsNativeBilibiliEmoji === true}
            disabled={!ready || sending}
            overlay={overlay}
            open={quickPickerOpen}
            onOpenChange={setQuickPickerOpen}
            draft={draft}
            onSelectEmoji={insertEmoji}
            onSelectMessage={selectStoredDanmaku}
          />
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
            variant="ghost"
            size="icon-sm"
            disabled={!canSubmit}
            onClick={() => void send()}
            aria-label={`发送${config.siteLabel}弹幕`}
            title={canSubmit ? "发送弹幕（Enter）" : statusText}
            aria-busy={sending}
            className={cn(
              COMPOSER_BUTTON_CLASS,
              // Idle, the button is as quiet as the picker opposite it. Once
              // the draft is actually sendable it fills in, so the primary
              // action reads at a glance without a permanent bright block
              // sitting in the player chrome.
              overlay
                ? cn(
                    COMPOSER_OVERLAY_GHOST_CLASS,
                    "disabled:text-white/45",
                    canSubmit && "bg-white text-black hover:bg-white hover:text-black",
                  )
                : cn(
                    "text-muted-foreground hover:text-foreground disabled:text-muted-foreground/60",
                    canSubmit &&
                      "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
                  ),
              // The disabled group already dims; a second opacity pass on the
              // button makes the icon nearly invisible over video. Dim via
              // colour above instead, so the affordance stays legible.
              "disabled:opacity-100",
            )}
          >
            {sending ? <Spinner aria-hidden /> : <SendHorizontal aria-hidden />}
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
