import { useState } from "react";
import type { PlayUrl } from "@/shared/types/live";
import { ErrorState } from "@/shared/components/ErrorState";
import { DanmakuPanel } from "./DanmakuPanel";
import { DanmakuSettingsPanel } from "./DanmakuSettingsPanel";
import { FollowPanel } from "./FollowPanel";
import { SuperChatPanel } from "./SuperChatPanel";
import { PlayerControls } from "./PlayerControls";
import { CanvasDanmaku } from "./canvas/CanvasDanmaku";
import { useWebPlayer } from "./player/useWebPlayer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { PlayerEvent } from "@/shared/types/player";

export type RoomSideTab = "chat" | "sc" | "settings" | "follow";

type PlayerPaneProps = {
  playUrl: PlayUrl | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  title?: string;
  danmakuActive?: boolean;
  danmakuStatusText?: string | null;
  sideHeader?: React.ReactNode;
  qualities?: { quality: string }[];
  qualityIndex?: number;
  onQualityChange?: (index: number) => void;
  lines?: { url: string }[];
  lineIndex?: number;
  onLineChange?: (index: number) => void;
  /** Refresh the active stream metadata and rebuild the MSE session. */
  onRefresh?: () => void;
  loadError?: string | null;
  reloadToken?: number;
  onPlayerMediaFailure?: (event: PlayerEvent) => void;
  onPlayerPlaying?: () => void;
  /** Stable room identity, used to discard messages during direct room switches. */
  roomSessionKey?: string;
  /** Controlled by RoomPage so a follow-list room switch keeps this tab open. */
  sideTab?: RoomSideTab;
  onSideTabChange?: (tab: RoomSideTab) => void;
};

/**
 * Room player — **web MSE path** (mpegts.js + localhost stream proxy).
 *
 * No mpv / no native HWND / no companion overlay window. Video + scrolling
 * danmaku share one DOM stack; leave-room unmount stops everything cleanly.
 */
export function PlayerPane({
  playUrl,
  loading,
  error,
  onRetry,
  danmakuActive = false,
  danmakuStatusText,
  sideHeader,
  qualities = [],
  qualityIndex = 0,
  onQualityChange,
  lines = [],
  lineIndex = 0,
  onLineChange,
  onRefresh,
  loadError: externalLoadError,
  reloadToken = 0,
  onPlayerMediaFailure,
  onPlayerPlaying,
  roomSessionKey,
  sideTab,
  onSideTabChange,
}: PlayerPaneProps) {
  const [sidePanelOpen, setSidePanelOpen] = useState(true);
  const [osdOn, setOsdOn] = useState(true);

  const player = useWebPlayer({
    playUrl,
    sessionKey: roomSessionKey,
    reloadToken,
    onMediaFailure: onPlayerMediaFailure,
    onPlaying: onPlayerPlaying,
  });

  const displayError =
    error ??
    (player.loadError
      ? { code: "play_error", message: player.loadError, site: null, retryable: true }
      : null);
  const showHost = !loading && displayError == null && !!playUrl;
  const transportDisabled = !showHost;
  // A failed MSE session still has a stream URL and must be refreshable; the
  // error state is precisely where this control is most useful.
  const refreshDisabled = loading || !playUrl;
  const loadError = externalLoadError ?? player.loadError;
  const danmakuSessionKey = `${roomSessionKey ?? "room"}:${playUrl?.url ?? "idle"}`;

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="relative flex min-w-0 flex-1 flex-col bg-black">
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={player.stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
            {loading && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                <Spinner className="size-8 text-primary" />
                <p className="text-sm">正在解析线路…</p>
              </div>
            )}
            {!loading && displayError != null && (
              <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
                <div className="w-full max-w-md">
                  <ErrorState error={displayError} title="播放不可用" onRetry={onRetry} />
                </div>
              </div>
            )}
            {!loading && displayError == null && !playUrl && (
              <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-muted-foreground">
                未选择流
              </div>
            )}

            {/* key=mediaKey forces a clean <video> after leave/re-enter (MSE). */}
            <video
              key={player.mediaKey}
              ref={player.videoRef}
              className="absolute inset-0 h-full w-full bg-black object-contain"
              playsInline
              autoPlay
              controls={false}
            />

            {showHost && !player.running && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <Spinner className="size-8 text-white/70" />
              </div>
            )}

            {/* Floating danmaku over the picture (same DOM stack as Simple Live). */}
            {showHost && osdOn && (
              <CanvasDanmaku
                active={danmakuActive && osdOn}
                sessionKey={danmakuSessionKey}
                className="z-10"
              />
            )}
          </div>

          <PlayerControls
            paused={player.paused}
            volume={player.volume}
            muted={player.muted}
            sidePanelOpen={sidePanelOpen}
            osdOn={osdOn}
            qualities={qualities}
            qualityIndex={qualityIndex}
            lines={lines}
            lineIndex={lineIndex}
            fullscreen={player.mode === "fullscreen"}
            loadError={loadError}
            disabled={transportDisabled}
            refreshDisabled={refreshDisabled}
            onRefresh={onRefresh}
            onTogglePause={() => player.togglePause()}
            onVolume={(v) => player.changeVolume(v)}
            onToggleSidePanel={() => setSidePanelOpen((open) => !open)}
            onToggleOsd={() => setOsdOn((v) => !v)}
            onQualityChange={onQualityChange ?? (() => {})}
            onLineChange={onLineChange ?? (() => {})}
            onToggleFullscreen={() => void player.toggleFullscreen()}
          />
        </div>
      </div>

      <aside
        aria-hidden={!sidePanelOpen}
        className={cn(
          "flex w-[300px] shrink-0 flex-col border-l border-border bg-sidebar lg:w-[320px]",
          "max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-10 max-md:h-56 max-md:w-full max-md:border-t max-md:border-l-0",
          !sidePanelOpen && "hidden",
        )}
      >
        {sideHeader}
        <Tabs
          {...(sideTab ? { value: sideTab } : { defaultValue: "chat" })}
          className="flex min-h-0 flex-1 flex-col gap-0"
          onValueChange={(value) => onSideTabChange?.(value as RoomSideTab)}
        >
          <TabsList
            variant="line"
            className="w-full justify-start rounded-none border-b border-border bg-transparent px-2"
          >
            <TabsTrigger value="chat">聊天</TabsTrigger>
            <TabsTrigger value="sc">SC</TabsTrigger>
            <TabsTrigger value="settings">弹幕设置</TabsTrigger>
            <TabsTrigger value="follow">关注</TabsTrigger>
          </TabsList>
          <TabsContent
            value="chat"
            keepMounted
            className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
          >
            <DanmakuPanel
              key={`chat:${roomSessionKey ?? "room"}`}
              active={danmakuActive}
              visible={sidePanelOpen && (sideTab === undefined || sideTab === "chat")}
              statusText={danmakuStatusText}
              className="h-full"
            />
          </TabsContent>
          <TabsContent value="sc" keepMounted className="mt-0 min-h-0 flex-1 data-[hidden]:hidden">
            <SuperChatPanel
              key={`sc:${roomSessionKey ?? "room"}`}
              active={danmakuActive}
              visible={sidePanelOpen && (sideTab === undefined || sideTab === "sc")}
              className="h-full"
            />
          </TabsContent>
          <TabsContent
            value="settings"
            keepMounted
            className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
          >
            <DanmakuSettingsPanel className="h-full" />
          </TabsContent>
          <TabsContent
            value="follow"
            keepMounted
            className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
          >
            <FollowPanel className="h-full" />
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  );
}
