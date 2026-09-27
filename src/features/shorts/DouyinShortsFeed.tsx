import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  FastForward,
  Film,
  Info,
  Link2,
  RefreshCw,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ErrorState } from "@/shared/components/ErrorState";
import { ShortsInfoSkeleton } from "./ShortsStageSkeleton";
import { PlayerHudOverflowMenu, PlayerToolTile } from "@/shared/components/player/PlayerHudMenu";
import {
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { useCoarsePointer } from "@/shared/hooks/useCoarsePointer";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { hasBrowserHistoryEntry } from "@/app/androidBackNavigation";
import { cn } from "@/lib/utils";
import { formatVideoDuration } from "@/features/video/videoHistory";
import { ShortsStage, ShortsPoster } from "./ShortsStage";
import { ShortsSeekBar } from "./ShortsSeekBar";
import { ShortsSeekBridge, ShortsSeekPlayer } from "./shortsSeekPlayer";
import { useShortsInteraction } from "./useShortsInteraction";
import { useShortsMediaSlots } from "./useShortsSlots";
import { useShortsMediaSessionRetention } from "./useShortsSessionRetention";
import { DOUYIN_SHORTS_SOURCE } from "./shortsPlaybackSource";
import { useDouyinShortsFeed } from "./useDouyinShortsFeed";
import { DOUYIN_FEED_MAX_BATCHES } from "./douyinFeed";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_BOTTOM_CONTROLS_HEIGHT_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SEEK_BAR_HIT_OVERHANG_PX,
  SHORTS_SLOT_IDS,
  SHORTS_TOP_BAR_HEIGHT_PX,
  shortsMountedIndexes,
  shortsSlotCoveredIndexes,
  shortsSlotTop,
} from "./shortsFeed";
import type { DouyinVideoItem } from "./douyinVideoApi";

const NO_THUMBNAILS: [] = [];
const noop = () => {};
const TOP_CONTROLS =
  "media-skin [--media-control-size:2.5rem] [@media(pointer:coarse)]:[--media-control-size:2.75rem]";

function stageItem(item: DouyinVideoItem) {
  return {
    title: item.title,
    cover: item.cover,
    dimension: { width: item.width, height: item.height, rotate: 0 },
  };
}

/** 抖音只提供内容与能力边界；舞台、三槽、手势、进度条均复用 B 站实现。 */
export function DouyinShortsFeed({ onRefresh }: { onRefresh: () => void }) {
  const navigate = useNavigate();
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const c = useRef<HTMLVideoElement>(null);
  const refs = useMemo(() => ({ a, b, c }), []);
  const [motionActive, setMotionActive] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoVisible, setInfoVisible] = useState(true);
  const [stageColumn, setStageColumn] = useState(0);
  const coarse = useCoarsePointer();
  const compact = useCompactPlayerViewport();
  const column = coarse ? stageColumn : 0;
  const feed = useDouyinShortsFeed(motionActive);
  const { items, index, setIndex, query } = feed;
  const current = items[index];
  const retention = useShortsMediaSessionRetention(DOUYIN_SHORTS_SOURCE.stop);
  const { slots, slotStates, playback, noteDirection } = useShortsMediaSlots({
    source: DOUYIN_SHORTS_SOURCE,
    items,
    index,
    refs,
    retention,
  });
  const interaction = useShortsInteraction({
    items,
    index,
    setIndex,
    viewportRef,
    trackRef,
    playback,
    navigationLocked: !current,
    blocked: menuOpen,
    onMotionActiveChange: setMotionActive,
    noteDirection,
    onBoundary: (next) => {
      if (next >= items.length && !query.isFetchNextPageError) feed.loadMore();
    },
  });
  const goBack = () => {
    if (hasBrowserHistoryEntry(window.history.state)) navigate(-1);
    else navigate("/shorts", { replace: true });
  };
  const run = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };
  const covered = shortsSlotCoveredIndexes(slots);
  const loadingMore = query.isFetchingNextPage;
  const exhausted = query.isSuccess && !query.hasNextPage && items.length > 0;

  return (
    <div data-slot="douyin-recommendation" className="h-full min-h-0">
      <ShortsSeekPlayer>
        <div
          ref={viewportRef}
          data-slot="shorts-viewport"
          data-platform="douyin"
          data-current-id={current?.id}
          className="media-skin relative h-full min-h-0 overflow-hidden bg-black text-media-controls-foreground"
          style={{ touchAction: "pan-x", "--media-scale-unit": "1.2rem" } as React.CSSProperties}
          onPointerDownCapture={menuOpen ? undefined : interaction.onPointerDownCapture}
          onPointerMoveCapture={menuOpen ? undefined : interaction.onPointerMoveCapture}
          onPointerUpCapture={interaction.onPointerUpCapture}
          onPointerCancelCapture={interaction.onPointerCancelCapture}
          onWheel={menuOpen ? undefined : interaction.onWheel}
        >
          <div ref={trackRef} data-slot="shorts-track" className="relative h-full">
            {SHORTS_SLOT_IDS.map((slotId) => {
              const held = slots.held[slotId];
              const item = held == null ? null : items[held];
              if (!item) return null;
              const active = slotId === slots.active;
              return (
                <div
                  key={slotId}
                  data-slot="shorts-panel"
                  data-slot-id={slotId}
                  aria-hidden={active ? undefined : true}
                  inert={active ? undefined : true}
                  className="absolute inset-x-0 h-full"
                  style={{ top: shortsSlotTop(held) }}
                >
                  <ShortsStage
                    item={stageItem(item)}
                    playback={slotStates[slotId]}
                    videoRef={refs[slotId]}
                    mode={active ? "play" : "warm"}
                    gestureActive={interaction.gestureActive}
                    onSurfaceTap={interaction.onSurfaceTap}
                    onChromeColumn={setStageColumn}
                  />
                </div>
              );
            })}
            {shortsMountedIndexes(index, items.length).map((position) => {
              if (covered.has(position)) return null;
              const item = items[position];
              return (
                <div
                  key={item.id}
                  data-slot="shorts-panel"
                  aria-hidden
                  inert
                  className="absolute inset-x-0 h-full"
                  style={{ top: shortsSlotTop(position) }}
                >
                  <ShortsPoster item={stageItem(item)} />
                </div>
              );
            })}
          </div>
          <ShortsSeekBridge
            videoRef={refs[slots.active]}
            active={current ? slots.active : "empty"}
          />

          {!current && query.isPending && (
            // 推荐元数据未到：顶部控制栏与底部操作栏已经是真的，只补左下角那块
            // 信息浮层的位置（作品到达后它就在那里）。画面区留黑。
            <>
              <span role="status" className="sr-only">
                正在加载抖音推荐…
              </span>
              <ShortsInfoSkeleton />
            </>
          )}

          {!current && !query.isPending && (
            <div className="absolute inset-x-0 inset-y-16 flex flex-col items-center justify-center gap-4 px-6">
              {query.isError ? (
                <ErrorState
                  error={query.error}
                  title="推荐加载失败"
                  onRetry={onRefresh}
                  action={
                    <Link
                      to="/settings?section=account"
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      前往设置管理抖音账号
                    </Link>
                  }
                />
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>暂无可播放推荐</EmptyTitle>
                    <EmptyDescription>
                      本批没有支持的公开视频，可刷新或改用作品链接。
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button variant="outline" onClick={onRefresh}>
                    刷新推荐
                  </Button>
                </Empty>
              )}
              <p className="max-w-md text-center text-sm text-white/70">
                推荐需本机登录 Cookie，不保证个性化效果，不绕过访问验证。
              </p>
            </div>
          )}

          <div
            data-slot="shorts-chrome-column"
            className={cn(
              "pointer-events-none absolute inset-y-0 z-20",
              column === 0 && "inset-x-0",
            )}
            style={
              column > 0 ? { left: `calc(50% - ${column / 2}px)`, width: `${column}px` } : undefined
            }
          >
            <div
              data-slot="shorts-top-bar"
              className={cn(
                TOP_CONTROLS,
                "pointer-events-auto absolute inset-x-0 top-0 z-20 flex items-center gap-1.5 px-2",
              )}
              style={{ height: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
            >
              <MediaButton
                className={PLAYER_HUD_BUTTON_CLASS}
                aria-label="返回上一页"
                title="返回上一页"
                onClick={goBack}
              >
                <ArrowLeft className={PLAYER_HUD_ICON_CLASS} aria-hidden />
              </MediaButton>
              <h1 className="pointer-events-none text-sm font-medium text-white">抖音推荐</h1>
              <span className="ml-auto">
                <PlayerHudOverflowMenu
                  label="更多操作"
                  title="抖音短视频操作"
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  compact={compact}
                >
                  <div className="grid grid-cols-2 gap-1.5 max-md:gap-2">
                    <PlayerToolTile
                      icon={playback.muted ? VolumeX : Volume2}
                      label={playback.muted ? "取消静音" : "静音"}
                      pressed={playback.muted}
                      onClick={run(playback.toggleMuted)}
                    />
                    <PlayerToolTile
                      icon={RefreshCw}
                      label="重新加载作品"
                      onClick={run(playback.retry)}
                    />
                    <PlayerToolTile icon={RefreshCw} label="刷新推荐" onClick={run(onRefresh)} />
                    <PlayerToolTile
                      icon={Link2}
                      label="作品链接"
                      onClick={run(() => navigate("/shorts/douyin?tab=link"))}
                    />
                    <PlayerToolTile
                      icon={Film}
                      label="B 站短视频"
                      onClick={run(() => navigate("/shorts/bilibili"))}
                    />
                    <PlayerToolTile
                      icon={Settings}
                      label="账号设置"
                      onClick={run(() => navigate("/settings?section=account"))}
                    />
                  </div>
                </PlayerHudOverflowMenu>
              </span>
            </div>
            {playback.rate > 1 && (
              <div
                data-slot="shorts-speed-hint"
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-sm text-white"
                style={{ top: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
              >
                <FastForward className="size-3.5" aria-hidden />
                {playback.rate.toFixed(1)}x 倍速中
              </div>
            )}
            {current && query.isFetchNextPageError && (
              <div
                className="pointer-events-auto absolute inset-x-4 z-20"
                style={{ top: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
              >
                <ErrorState
                  error={query.error}
                  title="追加推荐失败"
                  onRetry={feed.loadMore}
                  className="bg-black/90 px-3 py-2"
                />
              </div>
            )}
            <div
              className={cn(
                "pointer-events-auto absolute bottom-1/2 z-20 hidden translate-y-1/2 flex-col gap-2 md:flex",
                column > 0 ? "left-full ml-3" : "right-3",
              )}
            >
              <MediaButton
                aria-label="上一条"
                title="上一条（↑）"
                disabled={index === 0}
                onClick={() => interaction.goToIndex(index - 1)}
              >
                <ChevronUp aria-hidden />
              </MediaButton>
              <MediaButton
                aria-label="下一条"
                title="下一条（↓）"
                disabled={!current || (index >= items.length - 1 && !query.hasNextPage)}
                onClick={() => interaction.goToIndex(index + 1)}
              >
                <ChevronDown aria-hidden />
              </MediaButton>
            </div>
            {infoVisible && current && (
              <div
                data-slot="shorts-info-float"
                className="pointer-events-none absolute inset-x-0 z-20 bg-gradient-to-t from-black/70 to-transparent px-2 pt-8"
                style={{
                  bottom: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
                  paddingBottom: `${SHORTS_SEEK_BAR_HIT_OVERHANG_PX}px`,
                }}
              >
                <div className="flex max-w-md flex-col gap-1 text-white">
                  <p className="truncate text-sm font-medium">@{current.author || "未知作者"}</p>
                  <h2 className="line-clamp-3 text-sm">{current.title || "未命名作品"}</h2>
                  <p className="text-xs text-white/70">
                    {formatVideoDuration(playback.duration || current.duration)}
                  </p>
                </div>
              </div>
            )}
          </div>
          <div
            data-slot="shorts-bottom-bar"
            className="absolute inset-x-0 bottom-0 z-20 flex flex-col bg-black/85"
            style={{
              height: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
              paddingBottom: SHORTS_SAFE_AREA_BOTTOM,
            }}
          >
            <div
              className={cn("relative", column > 0 ? "mx-auto" : "w-full")}
              style={column > 0 ? { width: `${column}px` } : undefined}
            >
              <ShortsSeekBar thumbnails={NO_THUMBNAILS} onArmed={noop} />
            </div>
            <div
              className="flex flex-1 items-center gap-2 px-2 text-white"
              style={{ height: `${SHORTS_BOTTOM_CONTROLS_HEIGHT_PX}px` }}
            >
              <p role="status" className="min-w-0 flex-1 truncate text-xs text-white/70">
                {loadingMore
                  ? "正在加载更多推荐…"
                  : exhausted && index === items.length - 1
                    ? query.data.pages.length >= DOUYIN_FEED_MAX_BATCHES
                      ? "已达到本轮上限，可刷新推荐"
                      : "本轮暂无更多新作品，可刷新推荐"
                    : current
                      ? `${index + 1} / ${items.length} 条已加载`
                      : "抖音短视频"}
              </p>
              <Link
                to="/shorts/douyin?tab=link"
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                作品链接
              </Link>
              <MediaButton
                aria-label={infoVisible ? "隐藏视频信息" : "显示视频信息"}
                title={infoVisible ? "隐藏视频信息" : "显示视频信息"}
                aria-pressed={infoVisible}
                onClick={() => setInfoVisible((value) => !value)}
              >
                <Info aria-hidden />
              </MediaButton>
            </div>
          </div>
        </div>
      </ShortsSeekPlayer>
    </div>
  );
}
