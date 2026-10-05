import type { CSSProperties, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * 沉浸播放页共用的加载占位：画面保持纯黑，不模拟顶部或底部控制栏。
 * 返回按钮由调用方通过 `back` 插槽传入，不依赖播放器控制条。
 */

/**
 * 黑舞台上的骨架块。
 *
 * 必须覆盖 `Skeleton` 默认的 `bg-muted`：这几处表面是媒体皮肤的黑底，而
 * `bg-muted` 是主题色 —— 浅色主题下它是接近白色的浅灰，铺在黑底上亮得像内容
 * 已经加载出来了。10% 的白与 `--media-muted`（15%）同一档观感。
 *
 * 主题表面（如侧栏）的骨架**不要**用它，直接用 `Skeleton` 的默认底色。
 */
export function StageSkeletonBlock({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <Skeleton aria-hidden className={cn("bg-white/10", className)} style={style} />;
}

type PlayerStageSkeletonProps = {
  /** 读屏播报的加载文案。骨架对辅助技术是装饰，文案只能挂在这里。 */
  label?: string;
  /** HUD 左端的返回按钮。沉浸页必须传，否则加载态里没有出口。 */
  back?: ReactNode;
  /** 舞台内的其他层（如竖屏流的信息浮层骨架）。 */
  children?: ReactNode;
  className?: string;
};

/** 沉浸播放页的加载占位：纯黑画面与真实返回按钮。 */
export function PlayerStageSkeleton({
  label = "正在加载…",
  back,
  children,
  className,
}: PlayerStageSkeletonProps) {
  return (
    <div
      data-slot="player-stage-skeleton"
      className={cn(
        // 与真实 HUD 共用 0.9rem 缩放，避免返回按钮在加载完成时改变尺寸。
        "media-skin relative flex h-full min-h-0 flex-col overflow-hidden bg-black [--media-scale-unit:0.9rem]",
        className,
      )}
    >
      <span role="status" className="sr-only">
        {label}
      </span>
      {back && (
        <div className="absolute left-3 top-[max(0.625rem,var(--player-safe-area-top,0px))] z-30 text-white">
          {back}
        </div>
      )}
      {children}
    </div>
  );
}
