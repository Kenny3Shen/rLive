import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
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
import { glassTitleClass } from "@/shared/components/player/glassSurface";
import { cn } from "@/lib/utils";
import { BILIBILI_NATIVE_TEXT_EMOJIS, DANMAKU_EMOJIS } from "./danmaku/emoji";
import { insertBilibiliDanmakuText } from "./danmaku/outgoing";
import {
  getDanmakuSendConfig,
  isDanmakuSendSite,
  VIDEO_DANMAKU_SEND_CONFIG,
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
  roomTitle?: string;
  roomUserName?: string;
  /** 供播放器浮层控制条使用的紧凑透明变体。 */
  overlay?: boolean;
  /** 全屏播放器浮层使用的 Portal 目标。 */
  portalContainer?: HTMLElement | RefObject<HTMLElement | null> | null;
  /** 表情选择器打开期间保持播放器 chrome 可见。 */
  onOverlayInteractionChange?: (open: boolean) => void;
  /** 视频页目标：发送 VOD 弹幕（oid = cid，历史按 aid 记）。 */
  video?: {
    cid: number;
    aid: string;
    /** 当前播放位置（秒），让弹幕落在正确的进度条位置。 */
    progressSecs: number;
  };
};

type DanmakuPickerTab = "emoji" | "favorites" | "history";

/**
 * 快捷选择器和发送按钮分列输入框两侧。共享同一几何尺寸让整组对称，
 * 且比组合 2rem 高度略小一档，
 * 使任何一个按钮都不会碰到边框。
 */
const COMPOSER_BUTTON_CLASS = "size-7 rounded-md transition-colors";
/** 匹配浮层输入框所在的透明播放器 chrome。 */
const COMPOSER_OVERLAY_GHOST_CLASS =
  "text-white/90 hover:bg-white/15 hover:text-white aria-expanded:bg-white/15 aria-expanded:text-white focus-ring-overlay";

type DanmakuQuickPickerProps = {
  siteId: DanmakuSendSiteId;
  siteLabel: string;
  supportsNativeBilibiliEmoji: boolean;
  disabled: boolean;
  overlay: boolean;
  portalContainer?: HTMLElement | RefObject<HTMLElement | null> | null;
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
  portalContainer,
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
              overlay
                ? COMPOSER_OVERLAY_GHOST_CLASS
                : "text-muted-foreground hover:text-foreground",
            )}
          />
        }
      >
        <SmilePlus aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        container={portalContainer}
        data-mobile-static-backdrop
        side="top"
        align="start"
        aria-label={`${siteLabel}快捷弹幕面板`}
        className={cn(
          "w-80 max-h-(--available-height) max-w-(--available-width) overflow-x-hidden overflow-y-auto overscroll-contain gap-2 p-2",
          overlay && "border-white/10 bg-black/90 text-white shadow-xl backdrop-blur-md",
        )}
      >
        <PopoverTitle className={cn("px-0.5", glassTitleClass({ overlay }))}>快捷弹幕</PopoverTitle>
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
                            overlay && "hover:bg-white/15 focus-ring-overlay",
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
                  overlay && "text-white/70 hover:bg-white/15 hover:text-white focus-ring-overlay",
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
                          overlay && "hover:bg-white/15 hover:text-white focus-ring-overlay",
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
                            "text-white/70 hover:bg-white/15 hover:text-white focus-ring-overlay",
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
                      "text-white/70 hover:bg-white/15 hover:text-white focus-ring-overlay",
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
                            overlay && "hover:bg-white/15 hover:text-white focus-ring-overlay",
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
                              "text-white/70 hover:bg-white/15 hover:text-white focus-ring-overlay",
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
 * 为具备已验证本地发送接口的平台提供的、刻意保持精简的用户手动输入框。
 * 平台聊天只在通过正常直播 websocket 流到达时才显示。
 */
export function DanmakuComposer({
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  overlay = false,
  portalContainer,
  onOverlayInteractionChange,
  video,
}: DanmakuComposerProps) {
  const danmakuSendEnabled = useSettingsStore((s) => s.danmakuSendEnabled);
  const danmakuSendPending = useSettingsStore((s) => s.danmakuSendPending);
  const danmakuCookieRevision = useSettingsStore((s) => s.danmakuCookieRevision);
  // 视频页固定 bilibili VOD 目标；直播页沿站点配置。
  const sendConfig = video ? VIDEO_DANMAKU_SEND_CONFIG : getDanmakuSendConfig(siteId);
  const [availability, setAvailability] = useState<DanmakuSendStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [quickPickerOpen, setQuickPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendInFlightRef = useRef(false);

  // 视频目标的标识键：effect 用它替代整个对象引用，避免每次渲染都重查状态。
  const videoKey = video ? `${video.cid}:${video.aid}` : "";

  useEffect(() => {
    if (!sendConfig) return;
    // 视频目标不需要房间号；直播目标没有房间号就没有可发送的目的地。
    if (!video && !roomId) return;
    let cancelled = false;
    setAvailability(null);
    // 显式发送权限还在等待持久化时不要询问后端。它落定后本副作用会再次运行，
    // 避免一个过期的禁用状态把输入框钉住直到用户重进房间。
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
  }, [siteId, roomId, sendConfig, danmakuSendEnabled, danmakuSendPending, danmakuCookieRevision, videoKey]);

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
  if (!sendConfig) return null;
  if (video) {
    if (!video.aid) return null;
  } else if (!roomId || !isDanmakuSendSite(siteId)) {
    return null;
  }
  // 守卫后：直播模式 siteId 必是发送站点，视频模式恒为 bilibili。
  const pickerSiteId = video ? ("bilibili" as const) : (siteId as DanmakuSendSiteId);

  const config = sendConfig;
  // 让收窄后的房间身份对异步发送回调保持稳定。早先的请求仍在途时，
  // React 可能已经渲染了另一个房间。
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
    // 状态更新是异步的，用一个 ref 填补微小间隙，
    // 否则连续的 Enter/点击事件可能把同一份草稿提交两次。
    if (!canSubmit || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setResult(null);
    const outgoingMessage = draft.trim();
    try {
      await invokeCmd<void>(
        config.sendCommand,
        video
          ? {
              cid: video.cid,
              aid: video.aid,
              progressSecs: video.progressSecs,
              message: outgoingMessage,
              videoTitle: roomTitle,
            }
          : {
              roomId: currentRoomId,
              message: outgoingMessage,
              roomTitle,
              roomUserName,
            },
      );
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
            "border-white/25 bg-black/30 text-white has-[[data-slot=input-group-control]:focus-visible]:border-white/70 has-[>input:disabled]:bg-black/20",
          result?.startsWith("发送失败") && "border-destructive/80",
        )}
      >
        <InputGroupAddon align="inline-start" className="py-0">
          <DanmakuQuickPicker
            siteId={pickerSiteId}
            siteLabel={config.siteLabel}
            supportsNativeBilibiliEmoji={config.supportsNativeBilibiliEmoji === true}
            disabled={!ready || sending}
            overlay={overlay}
            portalContainer={portalContainer}
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
              // 空闲时按钮与对面的选择器一样低调。草稿真正可发送时才填充颜色，
              // 使主操作一眼可辨，又不会在播放器 chrome 里常驻一块亮色。
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
              // 禁用组本身已经变暗；再给按钮叠一层透明度会让图标在视频上几乎不可见。
              // 改为在上面的配色中变暗，保持可辨识度。
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
          className={cn("size-12", overlay && "hover:bg-white/15 focus-ring-overlay")}
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
