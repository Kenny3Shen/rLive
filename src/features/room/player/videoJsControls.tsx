import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { createPlayer, selectPiP, selectPlaybackRate } from "@videojs/react";
import { I18nProvider } from "@videojs/react/i18n";
import "@videojs/react/i18n/locales/zh-CN/register";
import { liveFeature } from "@videojs/core/dom";
import { Video, videoFeatures } from "@videojs/react/video";
import { PlayerSurface } from "@/components/videojs/skins/shared/skin-surface";
import { LiveVideoHotkeys } from "@/components/videojs/skins/live-video/hotkeys";
import { LiveVideoStatusIndicators } from "@/components/videojs/skins/live-video/status-indicators";
import { VideoHotkeys } from "@/components/videojs/skins/video/hotkeys";
import { VideoStatusIndicators } from "@/components/videojs/skins/video/status-indicators";

/** Video.js 原生 Player store；直播与点播共享媒体状态，控制栏由自定义控制栏渲染。 */
const videoJsPlayer = createPlayer({
  features: [...videoFeatures, liveFeature],
  displayName: "rLiveVideoPlayer",
});

export const VideoJsPlayerProvider = videoJsPlayer.Player;
export const useVideoJsPlayer = videoJsPlayer.usePlayer;
export const useVideoJsMedia = videoJsPlayer.useMedia;
export const useVideoJsPiP = () => videoJsPlayer.usePlayer(selectPiP);
export const useVideoJsPlaybackRate = () => videoJsPlayer.usePlayer(selectPlaybackRate);

type VideoJsContainerProps = Omit<ComponentProps<"div">, "children" | "controls"> & {
  children?: ComponentProps<"div">["children"];
  variant?: "live" | "vod";
  /** 自定义控制条，由 PlayerControls 渲染在媒体表面之上。 */
  controls: ReactNode;
};

/** 统一播放器表面。直播使用实时快捷键与状态提示，点播/录制显式传 `variant="vod"`。 */
export const VideoJsContainer = forwardRef<HTMLDivElement, VideoJsContainerProps>(
  function VideoJsContainer({ variant = "live", controls, ...props }, ref) {
    const isVod = variant === "vod";
    return (
      // 语言包随包注册，避免首帧英文；显式 locale 让 SSR 与 `<html lang>` 走同一套文案。
      <I18nProvider locale="zh-CN">
        <PlayerSurface
          variant={variant}
          hotkeys={isVod ? <VideoHotkeys /> : <LiveVideoHotkeys />}
          statusIndicators={isVod ? <VideoStatusIndicators /> : <LiveVideoStatusIndicators />}
          controlsSlot={controls}
          containerRef={ref}
          {...props}
        />
      </I18nProvider>
    );
  },
);

export { Video as VideoJsVideo };
