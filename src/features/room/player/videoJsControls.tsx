import { forwardRef, useMemo, type ComponentProps, type ReactNode } from "react";
import { createPlayer, liveFeature, selectPiP, selectPlaybackRate } from "@videojs/react";
import { I18nProvider } from "@videojs/react/i18n";
import "@videojs/react/i18n/locales/zh-CN/register";
import { notify } from "@/components/ui/toast";
import { videoJsPlayerErrorMessage } from "./videoJsPlayer";
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
/** 订阅官方 PiP 状态；浏览器拒绝切换只提示，不升级为致命播放错误。 */
export function useVideoJsPiP() {
  const pip = videoJsPlayer.usePlayer(selectPiP);
  return useMemo(() => {
    if (!pip) return undefined;
    const run = async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        notify.error("切换画中画失败", videoJsPlayerErrorMessage(error, "浏览器暂不允许此操作"));
      }
    };
    return {
      ...pip,
      requestPictureInPicture: () => run(pip.requestPictureInPicture),
      exitPictureInPicture: () => run(pip.exitPictureInPicture),
    };
  }, [pip]);
}
export const useVideoJsPlaybackRate = () => videoJsPlayer.usePlayer(selectPlaybackRate);

type VideoJsContainerProps = Omit<ComponentProps<"div">, "children" | "controls"> & {
  /** 全屏切换回调，传递给快捷键和按钮 */
  onToggleFullscreen?: () => void;
  children?: ComponentProps<"div">["children"];
  variant?: "live" | "vod";
  /** 自定义控制条，由 PlayerControls 渲染在媒体表面之上。 */
  controls: ReactNode;
};

/** 统一播放器表面。直播使用实时快捷键与状态提示，点播/录制显式传 `variant="vod"`。 */
export const VideoJsContainer = forwardRef<HTMLDivElement, VideoJsContainerProps>(
  function VideoJsContainer({ variant = "live", controls, onToggleFullscreen, ...props }, ref) {
    const isVod = variant === "vod";
    return (
      // 语言包随包注册，避免首帧英文；显式 locale 让 SSR 与 `<html lang>` 走同一套文案。
      <I18nProvider locale="zh-CN">
        <PlayerSurface
          ref={ref}
          variant={variant}
          hotkeys={
            isVod ? (
              <VideoHotkeys onToggleFullscreen={onToggleFullscreen} />
            ) : (
              <LiveVideoHotkeys onToggleFullscreen={onToggleFullscreen} />
            )
          }
          statusIndicators={isVod ? <VideoStatusIndicators /> : <LiveVideoStatusIndicators />}
          controlsSlot={controls}
          onToggleFullscreen={onToggleFullscreen}
          {...props}
        />
      </I18nProvider>
    );
  },
);

export { Video as VideoJsVideo };
