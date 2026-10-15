import { Headphones, VideoOff } from "lucide-react";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import {
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
  audioOnlyControlPresentation,
} from "./PlayerControls";

/**
 * 顶部控制栏的「仅播声音 / 恢复画面」开关：直播、视频、IPTV 与多画面共用一处。
 *
 * 原先只有点播把它放在 HUD（`4afbb653` 为章节菜单腾出控制栏左组），其余页面留在
 * 底部控制栏。统一到 HUD 之后，底部控制栏只留主播放动作与音量；移动端竖屏原本
 * 把它收在 HUD 溢出抽屉里，现在与桌面同为一枚常驻图标。
 *
 * 图标与文案取自 `audioOnlyControlPresentation`，与底部控制栏当年用的是同一份判定，
 * 因此「已开启」仍然只靠 `Headphones` / `VideoOff` 区分，不铺底色（见播放器技术文档
 * 第 5 节开关类按钮的底色约定）。样式必须走 `PLAYER_HUD_BUTTON_CLASS` /
 * `PLAYER_HUD_ICON_CLASS`，否则尺寸与配色会与同一排的其它 HUD 按钮对不上。
 */
export function PlayerAudioOnlyButton({
  audioOnly,
  onToggle,
}: {
  audioOnly: boolean;
  onToggle: () => void;
}) {
  const audio = audioOnlyControlPresentation(audioOnly);
  return (
    <MediaButton
      type="button"
      aria-label={audio.label}
      aria-pressed={audio.enabled}
      title={audio.label}
      className={PLAYER_HUD_BUTTON_CLASS}
      onClick={onToggle}
    >
      {audio.enabled ? (
        <Headphones className={PLAYER_HUD_ICON_CLASS} aria-hidden />
      ) : (
        <VideoOff className={PLAYER_HUD_ICON_CLASS} aria-hidden />
      )}
    </MediaButton>
  );
}
