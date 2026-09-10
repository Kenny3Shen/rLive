import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { createPlayer, selectPiP, selectPlaybackRate } from "@videojs/react";
import { I18nProvider } from "@videojs/react/i18n";
import "@videojs/react/i18n/locales/zh-CN/register";
import { liveFeature } from "@videojs/core/dom";
import { Video, videoFeatures } from "@videojs/react/video";
import { DefaultLiveVideoSkin } from "@/components/videojs/skins/live-video/skin";
import { DefaultVideoSkin } from "@/components/videojs/skins/video/skin";

/** Video.js 原生 Player store；直播与点播皮肤共享媒体状态，控制栏由 ejected skin 组合。 */
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
  /** 控制条由皮肤渲染在媒体表面之上；业务用 PlayerControls 组合原生控件后传入。 */
  controls: ReactNode;
};

/**
 * 统一播放器表面。直播默认使用 LiveVideoSkin；点播/录制显式传 `variant="vod"`
 * 使用 VideoSkin。两种皮肤都保留 Video.js 原生控件、手势、快捷键和状态提示。
 */
export const VideoJsContainer = forwardRef<HTMLDivElement, VideoJsContainerProps>(
  function VideoJsContainer({ variant = "live", controls, ...props }, ref) {
    const Skin = variant === "vod" ? DefaultVideoSkin : DefaultLiveVideoSkin;
    return (
      // 语言包随包注册，避免首帧英文；显式 locale 让 SSR 与 `<html lang>` 走同一套文案。
      <I18nProvider locale="zh-CN">
        <Skin {...props} controlsSlot={controls} containerRef={ref} />
      </I18nProvider>
    );
  },
);

export { Video as VideoJsVideo };
