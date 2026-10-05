import type { CSSProperties } from "react";
import { StageSkeletonBlock } from "@/shared/components/player/PlayerStageSkeleton";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SEEK_BAR_HIT_OVERHANG_PX,
} from "./shortsFeed";

/**
 * 竖屏流加载时保持纯黑画面，仅占位左下信息浮层，不模拟评论按钮或底部操作栏。
 * 返回按钮由页面提供真实的 `ShortsBackButton`。
 */

/**
 * 左下角信息浮层的占位。
 *
 * 坐标与真实的 `shorts-info-float` 完全一致（同一个底边、同一个让开进度条命中区的
 * 内边距、同一条渐变垫底），因此加载完成时那块渐变与文字不会跳位置。
 */
export function ShortsInfoSkeleton() {
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
            <StageSkeletonBlock className="size-8 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <StageSkeletonBlock className="h-3.5 w-24" />
              <StageSkeletonBlock className="h-3 w-16" />
            </div>
          </div>
          {/* 标题两行 + 播放统计一行。 */}
          <StageSkeletonBlock className="h-3.5 w-11/12" />
          <StageSkeletonBlock className="h-3.5 w-2/3" />
          <StageSkeletonBlock className="h-3 w-28" />
        </div>
      </div>
    </div>
  );
}

/** B 站短视频首屏：纯黑舞台与信息骨架，加载文案通过 `role="status"` 播报。 */
export function ShortsStageSkeleton({ label = "正在加载短视频…" }: { label?: string }) {
  return (
    <div
      data-slot="shorts-stage-skeleton"
      className="media-skin absolute inset-0 overflow-hidden bg-black"
      style={{ "--media-scale-unit": "1.2rem" } as CSSProperties}
    >
      <span role="status" className="sr-only">
        {label}
      </span>
      <ShortsInfoSkeleton />
    </div>
  );
}
