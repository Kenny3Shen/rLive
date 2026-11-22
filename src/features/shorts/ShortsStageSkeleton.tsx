import type { CSSProperties, ReactNode } from "react";
import { StageSkeletonBlock } from "@/shared/components/player/PlayerStageSkeleton";
import { ShortsLoadingIndicator } from "./ShortsLoadingIndicator";
import { ShortsChromeSkeleton } from "./ShortsChromeSkeleton";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SEEK_BAR_HIT_OVERHANG_PX,
} from "./shortsFeed";

/** 竖屏流无数据阶段保持纯黑画面，只给固定 chrome 与信息浮层留出稳定位置。 */

/**
 * 左下角信息浮层的占位。
 *
 * 坐标与真实的 `shorts-info-float` 完全一致（同一个底边、同一个让开进度条命中区的
 * 内边距、同一条渐变垫底），因此加载完成时那块渐变与文字不会跳位置。
 */
function ShortsInfoSkeleton() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 z-20 bg-gradient-to-t from-black/70 to-transparent px-2 pt-8"
      style={{
        bottom: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
        paddingBottom: `${SHORTS_SEEK_BAR_HIT_OVERHANG_PX}px`,
      }}
    >
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 max-w-md flex-1 flex-col gap-2">
          {/* UP 主块：头像跨两行文字，与真实信息浮层的构图一致。 */}
          <div className="flex items-center gap-2 py-1">
            <StageSkeletonBlock className="size-8 shrink-0 animate-none rounded-full" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <StageSkeletonBlock className="h-3.5 w-24 animate-none" />
              <StageSkeletonBlock className="h-3 w-16 animate-none" />
            </div>
          </div>
          {/* 标题两行 + 播放统计一行。 */}
          <StageSkeletonBlock className="h-3.5 w-11/12 animate-none" />
          <StageSkeletonBlock className="h-3.5 w-2/3 animate-none" />
          <StageSkeletonBlock className="h-3 w-28 animate-none" />
        </div>
      </div>
    </div>
  );
}

/**
 * B 站短视频无数据阶段：纯黑舞台、稳定居中的起播转圈与固定 chrome 骨架。
 *
 * 路由模块 Suspense、推荐流查询首屏与媒体首帧前都复用同一套顶部/底部 chrome
 * 几何。推荐数据到达后的媒体等待阶段由 `ShortsPanelChrome` 复用其中的轻量块，
 * 但信息区改为真实作者、标题与评论入口。
 */
export function ShortsStageSkeleton({
  label = "正在加载短视频…",
  back,
}: {
  label?: string;
  /** feed 首屏传入真实返回口；路由模块尚未加载时留空，显示同尺寸占位。 */
  back?: ReactNode;
}) {
  return (
    <div
      data-slot="shorts-stage-skeleton"
      className="media-skin absolute inset-0 overflow-hidden bg-black"
      style={{ "--media-scale-unit": "1.2rem" } as CSSProperties}
    >
      <span role="status" className="sr-only">
        {label}
      </span>
      <ShortsLoadingIndicator />
      <ShortsChromeSkeleton back={back} />
      <ShortsInfoSkeleton />
    </div>
  );
}
