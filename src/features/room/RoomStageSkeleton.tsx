import { ChevronLeft } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { cn } from "@/lib/utils";
import { isMobileClient } from "@/shared/clientPlatform";
import {
  useCompactLandscapePlayerViewport,
  useCompactPlayerViewport,
  useStackedDetailsViewport,
} from "@/shared/hooks/usePlayerViewport";
import {
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { PlayerStageSkeleton } from "@/shared/components/player/PlayerStageSkeleton";
import { sidePanelStartsOpen, usesStackedRoomSidePanel } from "./PlayerPane";

/**
 * 直播间详情未落定时的加载占位。
 *
 * 直播侧栏的内容（主播信息、页签、弹幕行）在数据到达前无法预测行数，用脉冲骨架
 * 只会先画出一组会全部被替换的假内容，短请求下反而加剧闪动。这里保留黑舞台、
 * 真实返回按钮、侧栏与底栏的几何占位和一个明确的加载指示：空间不跳，内容不假。
 *
 * 与真实布局共用同一组断点判据（`useCompactPlayerViewport` /
 * `sidePanelStartsOpen`），因此手机竖屏的「画面在上、聊天在下」与桌面端的
 * 「画面在左、320/340px 面板在右」在加载态就已经是对的。
 */
export function RoomStageSkeleton({ onBack }: { onBack: () => void }) {
  const compactViewport = useCompactPlayerViewport();
  const compactLandscapeViewport = useCompactLandscapePlayerViewport();
  const stackedDetailsViewport = useStackedDetailsViewport();
  // 与 `PlayerPane` 同一个初始取值：矮横屏的面板收进抽屉（不占位），
  // 其余形态一开始就把面板摆在画面旁边/下方。
  const showSidePanel = sidePanelStartsOpen(compactLandscapeViewport);
  const stacked = usesStackedRoomSidePanel(
    compactViewport,
    compactLandscapeViewport,
    stackedDetailsViewport,
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "relative flex h-full min-h-0 min-w-0 w-full bg-black",
            stacked && "flex-col",
          )}
        >
          <PlayerStageSkeleton
            label="正在加载直播间…"
            back={
              // 加载态的返回必须是真按钮：骨架只是占位，用户得能从加载态出去。
              // 配方与画面内 HUD 的返回箭头同一套，因此加载完成时不会换一颗。
              <MediaButton
                type="button"
                aria-label="返回上一页"
                className={PLAYER_HUD_BUTTON_CLASS}
                onClick={onBack}
              >
                <ChevronLeft
                  className={PLAYER_HUD_ICON_CLASS}
                  data-icon="inline-start"
                  aria-hidden
                />
              </MediaButton>
            }
            className={cn(stacked ? "h-auto aspect-video w-full flex-none" : "min-h-0 flex-1")}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 grid place-items-center"
            >
              <Spinner className="size-5 text-white/80" />
            </div>
          </PlayerStageSkeleton>
          {showSidePanel && <RoomSidePanelLoading stacked={stacked} />}
        </div>
      </div>
      {/* 桌面底部操作行只占高，不模拟按钮；移动端与平板不占位（与真实页同一条判据）。 */}
      {!isMobileClient() && (
        <div
          aria-hidden
          className="hidden shrink-0 border-t border-border/80 bg-sidebar/90 px-3 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] md:block"
        >
          <div className="h-7" />
        </div>
      )}
    </div>
  );
}

/**
 * 右侧/下方面板的加载占位：只保留真实页的几处固定几何。
 *
 * 信息卡外壳、页签条高度与列表区都按真实布局摆好，内容位置只放一个加载指示；
 * 弹幕行不再画错落的假宽度 —— 聊天内容的行数与宽度本来就要等上游给。
 */
function RoomSidePanelLoading({ stacked }: { stacked: boolean }) {
  return (
    <aside
      aria-hidden
      className={cn(
        "relative isolate flex min-h-0 min-w-0 flex-col overflow-hidden bg-sidebar",
        stacked
          ? "w-full flex-1 border-t border-border/80"
          : "w-[320px] shrink-0 border-l border-border/80 lg:w-[340px]",
      )}
    >
      <section className="shrink-0 border-b border-border px-2.5 py-2">
        <div className="h-[3.75rem] rounded-xl border border-border-subtle bg-card/75 shadow-sm" />
      </section>
      <div className="h-11 shrink-0 border-b border-border/80" />
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    </aside>
  );
}
