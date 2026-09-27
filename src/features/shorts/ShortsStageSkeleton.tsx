import type { CSSProperties } from "react";
import { StageSkeletonBlock } from "@/shared/components/player/PlayerStageSkeleton";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_BOTTOM_CONTROLS_HEIGHT_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SEEK_BAR_HEIGHT_PX,
  SHORTS_SEEK_BAR_HIT_OVERHANG_PX,
} from "./shortsFeed";

/**
 * 竖屏流的加载骨架。
 *
 * 画面区保持纯黑（视频本来就在那里），只把画面周围「本来就有东西」的位置画出来：
 * 左下角的信息浮层（头像 / 作者 / 标题 / 统计）与底部操作栏（进度条 + 输入框 +
 * 几个圆形按钮）。数据到达时这些位置直接换成真内容，几何不跳。
 *
 * 顶部控制栏不在这里：加载态里返回按钮已经是真的（`ShortsBackButton`），
 * 再画一条骨架会与它重叠。
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
        {/* 评论按钮与它的计数。 */}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <StageSkeletonBlock className="size-11 rounded-full" />
          <StageSkeletonBlock className="h-3 w-6" />
        </div>
      </div>
    </div>
  );
}

/**
 * 底部操作栏的占位：进度条（3px）+ 控制行（56px，输入框 + 三颗圆形按钮）。
 *
 * 高度、安全区与真实底栏走同一组常量，因此加载态与播放态的底栏是同一条。
 */
export function ShortsBottomBarSkeleton() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col bg-black/85"
      style={{
        height: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
        paddingBottom: SHORTS_SAFE_AREA_BOTTOM,
      }}
    >
      <StageSkeletonBlock
        className="w-full shrink-0 rounded-none bg-white/20"
        // 进度条只有 3px 布局高度；命中层是它向上的绝对定位子元素，不占布局。
        style={{ height: `${SHORTS_SEEK_BAR_HEIGHT_PX}px` }}
      />
      <div
        className="flex flex-1 items-center px-2"
        style={{ height: `${SHORTS_BOTTOM_CONTROLS_HEIGHT_PX}px` }}
      >
        <div className="mx-auto flex w-full max-w-lg items-center gap-1.5">
          {/* 弹幕输入框。 */}
          <StageSkeletonBlock className="h-9 min-w-0 flex-1 rounded-full" />
          {[0, 1, 2].map((index) => (
            <StageSkeletonBlock key={index} className="size-10 shrink-0 rounded-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * B 站短视频页的首屏骨架：纯黑画面 + 左下信息浮层 + 底栏。
 *
 * 加载文案挂在 `role="status"` 上（骨架本身对辅助技术是装饰）：读屏用户听到的
 * 与从前那条「正在加载短视频…」相同，视觉上不再是一块只有转圈的黑屏。
 */
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
      <ShortsBottomBarSkeleton />
    </div>
  );
}
