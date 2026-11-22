import type { ReactNode } from "react";
import { StageSkeletonBlock } from "@/shared/components/player/PlayerStageSkeleton";
import { cn } from "@/lib/utils";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_BOTTOM_CONTROLS_HEIGHT_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SEEK_BAR_HEIGHT_PX,
  SHORTS_TOP_BAR_HEIGHT_PX,
  SHORTS_TOP_CONTROLS_CLASS,
} from "./shortsFeed";

const STATIC_SKELETON_CLASS = "animate-none bg-white/10";
const CHROME_COLUMN_CLASS = "pointer-events-none absolute inset-y-0 z-20";
const BOTTOM_CONTROL_HEIGHT_CLASS =
  "h-10 min-h-10 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11";
const BOTTOM_BUTTON_SIZE_CLASS = "size-10 shrink-0 rounded-full [@media(pointer:coarse)]:size-11";

/** 顶部“更多”按钮的静态占位；尺寸与真实 HUD 按钮共用 40 / 44px 两档。 */
export function ShortsTopMoreSkeleton() {
  return (
    <StageSkeletonBlock
      className={cn("rounded-media-control", STATIC_SKELETON_CLASS, BOTTOM_BUTTON_SIZE_CLASS)}
    />
  );
}

/**
 * 顶部控制栏骨架。
 *
 * 有可用的真实返回入口时通过 `back` 传入，外壳只负责把它放到与成品相同的 52px
 * 栏位里；其他占位均不接指针，也不进入读屏顺序。
 */
export function ShortsTopBarSkeleton({ back }: { back?: ReactNode }) {
  return (
    <div
      data-slot="shorts-top-bar-skeleton"
      className={cn(
        SHORTS_TOP_CONTROLS_CLASS,
        "pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-1.5 px-2",
      )}
      style={{ height: `${SHORTS_TOP_BAR_HEIGHT_PX}px` }}
    >
      {back ? (
        <span data-slot="shorts-back-slot" className="pointer-events-auto">
          {back}
        </span>
      ) : (
        <StageSkeletonBlock
          className={cn("rounded-media-control", STATIC_SKELETON_CLASS, BOTTOM_BUTTON_SIZE_CLASS)}
        />
      )}
      <span aria-hidden className="pointer-events-none ml-auto">
        <ShortsTopMoreSkeleton />
      </span>
    </div>
  );
}

/**
 * 底部操作栏骨架。
 *
 * 高度、进度条位置、安全区与弹幕控制行都复用真实底栏常量。390px 宽时输入框会作为
 * `flex-1 min-w-0` 收缩，三颗圆形按钮固定 40 / 44px，不会把这一行撑出视口。
 */
export function ShortsBottomBarSkeleton({
  chromeColumn = 0,
}: {
  /** 粗指针宽屏上与画面同宽的控件列；0 表示通栏。 */
  chromeColumn?: number;
}) {
  return (
    <div
      aria-hidden
      data-slot="shorts-bottom-bar-skeleton"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col bg-black/85"
      style={{
        height: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
        paddingBottom: SHORTS_SAFE_AREA_BOTTOM,
      }}
    >
      <div
        className={cn("relative", chromeColumn > 0 ? "mx-auto" : "w-full")}
        style={{
          height: `${SHORTS_SEEK_BAR_HEIGHT_PX}px`,
          width: chromeColumn > 0 ? `${chromeColumn}px` : undefined,
        }}
      >
        <StageSkeletonBlock
          className={cn("absolute inset-0 rounded-none", STATIC_SKELETON_CLASS)}
        />
      </div>
      <div
        className="flex flex-1 items-center px-2"
        style={{ height: `${SHORTS_BOTTOM_CONTROLS_HEIGHT_PX}px` }}
      >
        <div
          className={cn(
            "mx-auto flex w-full items-center gap-1.5",
            chromeColumn === 0 && "max-w-lg",
          )}
          style={chromeColumn > 0 ? { width: `${chromeColumn}px` } : undefined}
        >
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md border border-white/15 bg-black/30 px-2",
              BOTTOM_CONTROL_HEIGHT_CLASS,
            )}
          >
            <StageSkeletonBlock
              className={cn("size-4 shrink-0 rounded-full", STATIC_SKELETON_CLASS)}
            />
            <StageSkeletonBlock className={cn("h-2.5 min-w-0 flex-1", STATIC_SKELETON_CLASS)} />
            <StageSkeletonBlock
              className={cn("size-4 shrink-0 rounded-full", STATIC_SKELETON_CLASS)}
            />
          </div>
          {Array.from({ length: 3 }, (_, index) => (
            <StageSkeletonBlock
              key={index}
              className={cn(BOTTOM_BUTTON_SIZE_CLASS, STATIC_SKELETON_CLASS)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 首屏与路由 Suspense 共用的轻量 chrome。
 *
 * 顶部和底部都是绝对定位浮层：画面仍保持纯黑，不绘制封面、大块视频骨架或交互控件。
 * `chromeColumn` 与真实短视频面板使用同一套收窄规则。
 */
export function ShortsChromeSkeleton({
  back,
  chromeColumn = 0,
}: {
  back?: ReactNode;
  chromeColumn?: number;
}) {
  return (
    <>
      <div
        data-slot="shorts-chrome-column"
        className={cn(CHROME_COLUMN_CLASS, chromeColumn === 0 && "inset-x-0")}
        style={
          chromeColumn > 0
            ? { left: `calc(50% - ${chromeColumn / 2}px)`, width: `${chromeColumn}px` }
            : undefined
        }
      >
        <ShortsTopBarSkeleton back={back} />
      </div>
      <ShortsBottomBarSkeleton chromeColumn={chromeColumn} />
    </>
  );
}
