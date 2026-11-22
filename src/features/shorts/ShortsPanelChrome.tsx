import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Ellipsis,
  FastForward,
  Info,
  ListVideo,
  MessageCircle,
  MessageSquareOff,
  MessageSquareText,
  RefreshCw,
  ScrollText,
  SendHorizontal,
  SmilePlus,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ThumbnailImage } from "@videojs/core";
import { useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { DanmakuComposer } from "@/features/room/BilibiliDanmakuComposer";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DrawerScope } from "@/components/ui/drawer";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import {
  danmakuControlPresentation,
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { PlayerHudOverflowMenu, PlayerToolTile } from "@/shared/components/player/PlayerHudMenu";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import type { VideoChapter, VideoItem } from "@/shared/types/video";
import { activeChapterIndex, playableChapters } from "@/features/video/videoChapters";
import { ShortsChapterMenu } from "./ShortsChapterMenu";
import { ShortsBottomBarSkeleton, ShortsTopMoreSkeleton } from "./ShortsChromeSkeleton";
import { ShortsSeekBar } from "./ShortsSeekBar";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_BOTTOM_CONTROLS_HEIGHT_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SEEK_BAR_HEIGHT_PX,
  SHORTS_SEEK_BAR_HIT_OVERHANG_PX,
  SHORTS_TOP_BAR_HEIGHT_PX,
  SHORTS_TOP_CONTROLS_CLASS,
} from "./shortsFeed";
import type { ShortsPlaybackState } from "./useShortsPlayback";

/** 触摸端评论入口：底栏上方留出的拇指操作区，以及避让顶栏的最小间距。 */
const SHORTS_MOBILE_COMMENT_BOTTOM_OFFSET_PX = 128;
const SHORTS_MOBILE_COMMENT_TOP_INSET_PX = 12;
const SHORTS_MOBILE_COMMENT_STACK_HEIGHT_PX = 60;

type ShortsPanelChromeProps = {
  item: VideoItem;
  playback: ShortsPlaybackState;
  active: boolean;
  compact: boolean;
  compactOrTouch: boolean;
  chromeColumn: number;
  infoVisible: boolean;
  danmakuVisible: boolean;
  chapters: readonly VideoChapter[] | undefined;
  thumbnails: ThumbnailImage[];
  warmProgressSeconds: number;
  warmDurationSeconds: number;
  chapterMenuOpen: boolean;
  commentsOpen: boolean;
  uploaderMode: boolean;
  uploaderCounter: string | null;
  uploaderStatus: ReactNode;
  navigationLocked: boolean;
  index: number;
  itemCount: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onEnterUploader: () => void;
  onOpenComments: () => void;
  onOpenDetail: () => void;
  onOpenInPlayer: () => void;
  onArmSeek: () => void;
  onChapterMenuOpenChange: (open: boolean) => void;
  onToggleDanmaku: () => void;
  onToggleInfo: () => void;
  onPrevious: () => void;
  onNext: () => void;
};

/**
 * 一个短视频 panel 的完整控件层。
 *
 * 控件与舞台处在同一个 `shorts-panel` 内，因此现有条带 transform、纵深缩放和收尾
 * WAAPI 会同时作用于画面、信息与控制栏。活动面板之外的槽位只画静态控件，不挂弹幕
 * 输入、章节菜单或进度条快照，避免预热面板提前发起额外 IPC。
 */
export function ShortsPanelChrome({
  item,
  playback,
  active,
  compact,
  compactOrTouch,
  chromeColumn,
  infoVisible,
  danmakuVisible,
  chapters,
  thumbnails,
  warmProgressSeconds,
  warmDurationSeconds,
  chapterMenuOpen,
  commentsOpen,
  uploaderMode,
  uploaderCounter,
  uploaderStatus,
  navigationLocked,
  index,
  itemCount,
  hasPreviousPage,
  hasNextPage,
  viewportRef,
  onBack,
  onEnterUploader,
  onOpenComments,
  onOpenDetail,
  onOpenInPlayer,
  onArmSeek,
  onChapterMenuOpenChange,
  onToggleDanmaku,
  onToggleInfo,
  onPrevious,
  onNext,
}: ShortsPanelChromeProps) {
  const controlsAvailable = playback.hasFrame || playback.ready || !!playback.error;
  const danmakuControl = danmakuControlPresentation(danmakuVisible);
  const warmChapters = playableChapters(chapters, warmDurationSeconds);
  const warmChapterIndex = activeChapterIndex(warmChapters, warmProgressSeconds);
  const warmChapterTitle = warmChapterIndex >= 0 ? warmChapters[warmChapterIndex].title : null;

  return (
    <>
      <div
        data-slot="shorts-chrome-column"
        className={cn(
          "pointer-events-none absolute inset-y-0 z-20",
          chromeColumn === 0 && "inset-x-0",
        )}
        style={
          chromeColumn > 0
            ? { left: `calc(50% - ${chromeColumn / 2}px)`, width: `${chromeColumn}px` }
            : undefined
        }
      >
        <div
          data-slot="shorts-top-bar"
          className={cn(
            SHORTS_TOP_CONTROLS_CLASS,
            "pointer-events-auto absolute inset-x-0 top-0 z-20 flex items-center gap-1.5 px-2",
          )}
          style={{ height: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
        >
          <ShortsBackButton
            onClick={active ? onBack : undefined}
            inline
            label={uploaderMode ? "返回推荐流" : "返回上一页"}
          />
          {uploaderMode && uploaderCounter && (
            <span
              data-slot="shorts-uploader-position"
              role="status"
              aria-label={`UP 主列表，第 ${uploaderCounter.replace("/", " 条，共 ")} 条`}
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm font-medium text-white tabular-nums"
            >
              {uploaderCounter}
            </span>
          )}
          <span className="pointer-events-none ml-auto">
            {!controlsAvailable ? (
              <ShortsTopMoreSkeleton />
            ) : active ? (
              <span className="pointer-events-auto">
                <ShortsMoreMenu
                  compact={compact}
                  muted={playback.muted}
                  onToggleMuted={playback.toggleMuted}
                  onRefresh={playback.retry}
                />
              </span>
            ) : (
              <MediaButton
                type="button"
                aria-hidden
                tabIndex={-1}
                className={PLAYER_HUD_BUTTON_CLASS}
              >
                <Ellipsis className={PLAYER_HUD_ICON_CLASS} />
              </MediaButton>
            )}
          </span>
        </div>

        {active && uploaderStatus && (
          <div
            data-slot="shorts-uploader-status"
            className="pointer-events-auto absolute inset-x-12 z-20 flex flex-col items-center gap-1 text-center text-xs text-white"
            style={{ top: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
          >
            {uploaderStatus}
          </div>
        )}

        {active && playback.rate > 1 && (
          <div
            data-slot="shorts-speed-hint"
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-sm font-medium text-white backdrop-blur-sm"
            style={{ top: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
          >
            <FastForward className="size-3.5" aria-hidden />
            {playback.rate.toFixed(1)}x 倍速中
          </div>
        )}

        <div
          className={cn(
            "pointer-events-auto absolute bottom-1/2 z-20 hidden translate-y-1/2 flex-col gap-2 md:flex",
            chromeColumn > 0 ? "left-full ml-3" : "right-3",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="上一条"
            title="上一条（↑）"
            disabled={navigationLocked || (index === 0 && !hasPreviousPage)}
            className="size-10 rounded-full bg-black/40 text-white/90 hover:bg-white/20 hover:text-white disabled:opacity-30"
            onClick={active ? onPrevious : undefined}
          >
            <ChevronUp aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="下一条"
            title="下一条（↓）"
            disabled={navigationLocked || (index >= itemCount - 1 && !hasNextPage)}
            className="size-10 rounded-full bg-black/40 text-white/90 hover:bg-white/20 hover:text-white disabled:opacity-30"
            onClick={active ? onNext : undefined}
          >
            <ChevronDown aria-hidden />
          </Button>
        </div>

        {infoVisible && (
          <div
            data-slot="shorts-info-float"
            className="pointer-events-none absolute inset-x-0 z-20 flex items-end justify-between gap-3 bg-gradient-to-t from-black/70 to-transparent px-2 pt-8"
            style={{
              bottom: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
              paddingBottom: `${SHORTS_SEEK_BAR_HIT_OVERHANG_PX}px`,
            }}
          >
            <div className="flex min-w-0 max-w-md flex-1 flex-col gap-2">
              <ShortsUploaderEntry
                item={item}
                active={active}
                navigationLocked={navigationLocked}
                onClick={onEnterUploader}
              />
              {!item.author_mid?.trim() && (
                <p className="text-xs text-white/70">UP 主标识缺失，暂不可查看列表</p>
              )}

              <div className="flex min-w-0 flex-col gap-0.5">
                {active ? (
                  <button
                    type="button"
                    aria-label={`视频详情：${item.title}`}
                    title="视频详情"
                    className="pointer-events-auto block w-full text-left"
                    onClick={onOpenDetail}
                  >
                    <ShortsVideoTitle title={item.title} />
                  </button>
                ) : (
                  <div className="pointer-events-none block w-full text-left">
                    <ShortsVideoTitle title={item.title} decorative />
                  </div>
                )}
                <p className="text-xs text-white/70">{formatOnline(item.view)} 次播放</p>
              </div>
              {(active || warmChapterTitle) && (
                <div
                  data-slot="shorts-chapters"
                  className="pointer-events-auto flex min-w-0 empty:hidden"
                >
                  {active ? (
                    <ShortsChapterMenu
                      chapters={chapters}
                      open={chapterMenuOpen}
                      onOpenChange={onChapterMenuOpenChange}
                      container={viewportRef}
                      compact={compact}
                    />
                  ) : (
                    <span
                      data-slot="player-chapter-pill"
                      className="inline-flex h-7 max-w-[min(18rem,70%)] min-w-0 items-center gap-1.5 rounded-full bg-black/35 px-2.5 text-sm text-white"
                    >
                      <ListVideo className="size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">{warmChapterTitle}</span>
                      <ChevronUp className="size-3.5 shrink-0 rotate-180" aria-hidden />
                    </span>
                  )}
                </div>
              )}
            </div>

            {!compactOrTouch && (
              <ShortsCommentButton
                reply={item.reply}
                open={active && commentsOpen}
                interactive={active}
                onClick={onOpenComments}
                className="self-start"
              />
            )}
            {compactOrTouch && <span aria-hidden className="w-11 shrink-0" />}
          </div>
        )}

        {infoVisible && compactOrTouch && (
          <ShortsCommentButton
            reply={item.reply}
            open={active && commentsOpen}
            interactive={active}
            onClick={onOpenComments}
            className="absolute right-2 z-20"
            style={{
              bottom: `min(calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM} + ${SHORTS_MOBILE_COMMENT_BOTTOM_OFFSET_PX}px), calc(100% - ${SHORTS_TOP_BAR_HEIGHT_PX + SHORTS_MOBILE_COMMENT_TOP_INSET_PX + SHORTS_MOBILE_COMMENT_STACK_HEIGHT_PX}px))`,
            }}
          />
        )}
      </div>

      {controlsAvailable ? (
        <div
          data-slot="shorts-bottom-bar"
          className="absolute inset-x-0 bottom-0 z-20 flex flex-col bg-black/85"
          style={{
            height: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
            paddingBottom: SHORTS_SAFE_AREA_BOTTOM,
          }}
        >
          <div
            className={cn("relative", chromeColumn > 0 ? "mx-auto" : "w-full")}
            style={chromeColumn > 0 ? { width: `${chromeColumn}px` } : undefined}
          >
            {active ? (
              <ShortsSeekBar thumbnails={thumbnails} onArmed={onArmSeek} />
            ) : (
              <ShortsWarmSeekBar currentTime={warmProgressSeconds} duration={warmDurationSeconds} />
            )}
          </div>
          <div
            className="flex flex-1 items-center px-2"
            style={{ height: `${SHORTS_BOTTOM_CONTROLS_HEIGHT_PX}px` }}
          >
            <div
              className={cn(
                "mx-auto flex w-full items-center gap-1.5",
                chromeColumn === 0 && "max-w-lg",
              )}
              style={chromeColumn > 0 ? { width: `${chromeColumn}px` } : undefined}
            >
              <div className="min-w-0 flex-1">
                {active ? (
                  <DanmakuComposer
                    overlay
                    overlayButtonHeight
                    roomTitle={item.title}
                    video={{
                      cid: item.cid ?? 0,
                      aid: item.aid,
                      getProgressMs: () => playback.getCurrentTime() * 1000,
                    }}
                  />
                ) : (
                  <ShortsComposerPlaceholder />
                )}
              </div>
              <ShortsBottomControl
                active={active}
                label={danmakuControl.label}
                pressed={danmakuVisible}
                onClick={onToggleDanmaku}
              >
                {danmakuControl.icon === "message-square-text" ? (
                  <MessageSquareText className="size-5" aria-hidden />
                ) : (
                  <MessageSquareOff className="size-5" aria-hidden />
                )}
              </ShortsBottomControl>
              <ShortsBottomControl
                active={active}
                label={infoVisible ? "隐藏视频信息与评论按钮" : "显示视频信息与评论按钮"}
                pressed={infoVisible}
                onClick={onToggleInfo}
              >
                <Info className="size-5" aria-hidden />
              </ShortsBottomControl>
              <ShortsBottomControl
                active={active}
                label="视频详情"
                title="视频详情（在播放页打开）"
                onClick={onOpenInPlayer}
              >
                <ScrollText className="size-5" aria-hidden />
              </ShortsBottomControl>
            </div>
          </div>
        </div>
      ) : (
        <ShortsBottomBarSkeleton chromeColumn={chromeColumn} />
      )}
    </>
  );
}

/** 离场面板的只读进度：保留离开活动态时的比例，不再订阅已切走的活动 Seek store。 */
function ShortsWarmSeekBar({ currentTime, duration }: { currentTime: number; duration: number }) {
  const ratio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  return (
    <div
      aria-hidden
      data-slot="shorts-seek-static"
      className="relative shrink-0"
      style={{ height: `${SHORTS_SEEK_BAR_HEIGHT_PX}px` }}
    >
      <div
        className="absolute inset-x-0 bottom-0 overflow-hidden bg-white/30"
        style={{ height: `${SHORTS_SEEK_BAR_HEIGHT_PX}px` }}
      >
        <span className="block h-full bg-white" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

function ShortsUploaderEntry({
  item,
  active,
  navigationLocked,
  onClick,
}: {
  item: VideoItem;
  active: boolean;
  navigationLocked: boolean;
  onClick: () => void;
}) {
  const content = (
    <>
      <Avatar className="size-8 shrink-0 after:border-white/40">
        <AvatarImage
          src={normalizeImageUrl(item.author_face)}
          alt=""
          aria-hidden
          referrerPolicy="no-referrer"
        />
        <AvatarFallback className="bg-black/40 text-xs text-white/90">
          {item.author?.slice(0, 1) || "U"}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-white">
          @{item.author || "未知 UP 主"}
        </span>
        {item.author_fans != null && (
          <span className="block truncate text-xs text-white/70">
            {formatOnline(item.author_fans)} 粉丝
          </span>
        )}
      </span>
    </>
  );
  const className =
    "pointer-events-auto h-auto max-w-full justify-start gap-2 self-start rounded-md px-0 py-1 text-left text-white hover:bg-white/15 hover:text-white";

  if (!active) {
    return (
      <div
        aria-hidden
        className="pointer-events-none flex h-auto max-w-full items-center justify-start gap-2 self-start rounded-md px-0 py-1 text-left text-white"
      >
        {content}
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      data-slot="shorts-uploader-entry"
      aria-label={`查看 ${item.author || "该 UP 主"} 的竖屏流`}
      title={
        item.author_mid?.trim() ? "从当前稿件浏览此 UP 主的竖屏流" : "UP 主标识缺失，暂不可查看列表"
      }
      disabled={!item.author_mid?.trim() || navigationLocked}
      className={className}
      onClick={onClick}
    >
      {content}
    </Button>
  );
}

function ShortsVideoTitle({ title, decorative = false }: { title: string; decorative?: boolean }) {
  return (
    <span data-slot="shorts-video-title" className="flex w-fit max-w-full items-end gap-1.5">
      <span className="line-clamp-2 min-w-0 text-sm text-white/90">{title}</span>
      <ChevronDown
        aria-hidden={decorative || undefined}
        className="mb-0.5 size-4 shrink-0 text-white/70"
      />
    </span>
  );
}

function ShortsCommentButton({
  reply,
  open,
  interactive,
  onClick,
  className,
  style,
}: {
  reply: number | null;
  open: boolean;
  interactive: boolean;
  onClick: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const buttonClassName = "size-11 rounded-full text-white/90 hover:bg-white/15 hover:text-white";

  return (
    <span
      className={cn("pointer-events-auto flex shrink-0 flex-col items-center", className)}
      style={style}
    >
      {interactive ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={reply != null && reply > 0 ? `评论，${formatOnline(reply)} 条` : "评论"}
          aria-expanded={open}
          title="评论"
          className={buttonClassName}
          onClick={onClick}
        >
          <MessageCircle className="size-6" aria-hidden />
        </Button>
      ) : (
        <span aria-hidden className="grid size-11 place-items-center rounded-full text-white/90">
          <MessageCircle className="size-6" />
        </span>
      )}
      {reply != null && reply > 0 && (
        <span className="text-[11px] text-white/80">{formatOnline(reply)}</span>
      )}
    </span>
  );
}

function ShortsBottomControl({
  active,
  label,
  title,
  pressed,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  title?: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const className =
    "size-10 shrink-0 rounded-full text-white/90 hover:bg-white/15 hover:text-white";
  if (!active) {
    return (
      <span
        aria-hidden
        className="grid size-10 shrink-0 place-items-center rounded-full text-white/90"
      >
        {children}
      </span>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={className}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ShortsComposerPlaceholder() {
  return (
    <InputGroup
      aria-hidden
      className="h-10 min-h-10 border-white/25 bg-black/30 text-white [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11"
    >
      <InputGroupAddon align="inline-start" className="py-0">
        <span className="grid size-7 place-items-center text-white/45">
          <SmilePlus className="size-4" />
        </span>
      </InputGroupAddon>
      <InputGroupInput disabled placeholder="输入弹幕…" className="text-sm text-white" />
      <InputGroupAddon align="inline-end" className="py-0">
        <span className="grid size-7 place-items-center text-white/45">
          <SendHorizontal className="size-4" />
        </span>
      </InputGroupAddon>
    </InputGroup>
  );
}

function ShortsMoreMenu({
  compact,
  muted,
  onToggleMuted,
  onRefresh,
}: {
  compact: boolean;
  muted: boolean;
  onToggleMuted: () => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const runAndClose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    // 独立 scope 不设 DrawerViewport：紧凑抽屉沿用整窗口 portal，避免继承关闭后零高的评论 dock。
    <DrawerScope>
      <PlayerHudOverflowMenu
        label="更多操作"
        title="短视频操作"
        open={open}
        onOpenChange={setOpen}
        compact={compact}
      >
        <div className="grid grid-cols-2 gap-1.5 max-md:gap-2">
          <PlayerToolTile
            icon={muted ? VolumeX : Volume2}
            label={muted ? "取消静音" : "静音"}
            pressed={muted}
            onClick={runAndClose(onToggleMuted)}
          />
          <PlayerToolTile icon={RefreshCw} label="重新加载" onClick={runAndClose(onRefresh)} />
        </div>
      </PlayerHudOverflowMenu>
    </DrawerScope>
  );
}

export function ShortsBackButton({
  onClick,
  inline,
  label = "返回上一页",
}: {
  onClick?: () => void;
  inline?: boolean;
  label?: string;
}) {
  return (
    <MediaButton
      type="button"
      aria-label={label}
      aria-hidden={onClick ? undefined : true}
      title={label}
      tabIndex={onClick ? undefined : -1}
      className={cn(
        PLAYER_HUD_BUTTON_CLASS,
        !inline && SHORTS_TOP_CONTROLS_CLASS,
        !inline && "absolute top-3 left-3 z-10",
      )}
      onClick={onClick}
    >
      <ChevronLeft className={PLAYER_HUD_ICON_CLASS} data-icon="inline-start" aria-hidden />
    </MediaButton>
  );
}
