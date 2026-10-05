import { ChevronLeft } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { cn } from "@/lib/utils";
import {
  useCompactLandscapePlayerViewport,
  useCompactPlayerViewport,
} from "@/shared/hooks/usePlayerViewport";
import {
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { PlayerStageSkeleton } from "@/shared/components/player/PlayerStageSkeleton";
import { sidePanelStartsOpen } from "./PlayerPane";

/**
 * 直播间详情未落定时的加载骨架。
 *
 * 纯黑舞台仅保留返回按钮，右侧主播/弹幕面板保留信息骨架。
 * 控制栏不做骨架；桌面底部操作行仅保留高度，避免详情到达后布局跳动。
 *
 * 与真实布局共用同一组断点判据（`useCompactPlayerViewport` /
 * `sidePanelStartsOpen`），因此手机竖屏的「画面在上、聊天在下」与桌面端的
 * 「画面在左、320/340px 面板在右」在加载态就已经是对的。
 */
export function RoomStageSkeleton({ onBack }: { onBack: () => void }) {
  const compactViewport = useCompactPlayerViewport();
  const compactLandscapeViewport = useCompactLandscapePlayerViewport();
  // 与 `PlayerPane` 同一个初始取值：矮横屏的面板收进抽屉（不占位），
  // 其余形态一开始就把面板摆在画面旁边/下方。
  const showSidePanel = sidePanelStartsOpen(compactLandscapeViewport);
  const stacked = compactViewport && !compactLandscapeViewport && showSidePanel;

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
          />
          {showSidePanel && <RoomSidePanelSkeleton stacked={stacked} />}
        </div>
      </div>
      {/* 桌面底部操作行只占高，不模拟按钮；移动端不占位。 */}
      <div
        aria-hidden
        className="hidden shrink-0 border-t border-border/80 bg-sidebar/90 px-3 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] md:block"
      >
        <div className="h-7" />
      </div>
    </div>
  );
}

/**
 * 右侧/下方面板的骨架：主播信息卡 + 页签条 + 弹幕行。
 *
 * 信息卡照抄 `RoomHostInfo` 的几何（44px 头像、两行文字、`rounded-xl` 卡片外壳），
 * 页签条与真实页签同高（`h-11`），弹幕行给错落的宽度 —— 等宽的骨架看起来像
 * 表格，不像聊天。
 */
function RoomSidePanelSkeleton({ stacked }: { stacked: boolean }) {
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
        <div className="overflow-hidden rounded-xl border border-border-subtle bg-card/75 px-2.5 py-2 shadow-sm">
          <div className="flex min-w-0 items-center gap-2.5">
            <Skeleton className="size-11 shrink-0 rounded-full ring-1 ring-border/80" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
        </div>
      </section>
      <div className="flex h-11 shrink-0 items-center gap-4 border-b border-border/80 px-4">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-4 w-8" />
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-2.5 py-2.5">
        {[92, 68, 84, 56, 76, 64, 88, 52, 72, 60].map((width, index) => (
          <Skeleton key={index} className="h-3.5" style={{ width: `${width}%` }} />
        ))}
      </div>
    </aside>
  );
}
