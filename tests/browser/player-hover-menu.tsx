import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PlayerControls } from "../../src/shared/components/player/PlayerControls";
import { VideoJsPlayerProvider } from "../../src/features/room/player/videoJsControls";
import { Popover, PopoverContent, PopoverTrigger } from "../../src/components/ui/popover";
import { Button as MediaButton } from "../../src/components/videojs/ui/button";
import { useHoverOpen } from "../../src/components/videojs/lib/use-hover-open";
import { mediaPopupTriggerOpenClass } from "../../src/components/videojs/lib/popup-surface";
import { cn } from "../../src/lib/utils";

/**
 * 控制栏悬停菜单的浏览器夹具：真实 `PlayerControls`（播放设置 + 字幕两个
 * `Menu.Root`）和一份与 VOD 字幕同构的 Base UI `Popover`，由
 * `tests/player-hover-menu.browser.js` 用真实鼠标驱动，验证「悬停展开后点
 * 触发器不收回」契约：
 *   - 悬停展开 → 点触发器本身 → 菜单仍在（回归前会被点击开合收回）；
 *   - Esc 与移开指针照旧收起；
 *   - 未悬停时的直接点击仍能打开。
 *
 * 页面级的 hover 媒体查询伪装写在 `player-hover-menu.html`：headless 报
 * `hover: none`，不伪装则 `useHoverOpen` 整条悬停路径都不生效。
 */

function VodSubtitleReplica() {
  const [open, setOpen] = useState(false);
  const hover = useHoverOpen(open, setOpen);
  return (
    <div data-vod-subtitle-replica className="absolute top-4 right-4">
      <Popover open={open} onOpenChange={hover.onOpenChange}>
        <PopoverTrigger
          {...hover.trigger}
          render={
            <MediaButton
              aria-label="VOD 字幕"
              className={cn("r-live-media-extension-button", open && mediaPopupTriggerOpenClass)}
            >
              CC
            </MediaButton>
          }
        />
        <PopoverContent side="top" align="end" {...hover.popup} className="w-40 p-2">
          <button type="button">关闭字幕</button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const host = document.getElementById("fixture");
if (!host) throw new Error("缺少 #fixture 挂载点");

createRoot(host).render(
  <div data-hover-menu-fixture>
    <VodSubtitleReplica />
    <VideoJsPlayerProvider>
      <PlayerControls
        qualities={[{ quality: "1080P" }, { quality: "720P" }]}
        qualityIndex={0}
        onQualityChange={() => {}}
        asrVisible
        onToggleAsr={() => {}}
        onToggleFullscreen={() => {}}
      />
    </VideoJsPlayerProvider>
  </div>,
);
