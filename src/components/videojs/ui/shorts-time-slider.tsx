import "../styles/theme.css";
import type { ThumbnailImage } from "@videojs/core";
import { Slider, TimeSlider as TimeSliderPrimitive } from "@videojs/react";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";

/**
 * 短视频进度条：Video.js `TimeSlider` 的细变体。
 *
 * 为什么不直接用播放页的 `time-slider.tsx`：那份带了章节分段、加载 spinner 与一整块
 * popover 表面，都是为了常规播放器的 32px 高控制栏设计的。短视频的进度条是底栏的
 * 上边缘：视觉 3px、命中层 20px 且只向上撑开，章节与 popover 表面在这里只会把画面
 * 底部重新糊住。共用的是原语与 `Slider.Thumbnail`，不是外观。
 *
 * 原语的硬前提（`TimeSlider.Root` 里 `if (!time) return null`）：必须挂在带
 * `timeFeature` 的 Player store 下，且该 store 已附着媒体元素。本组件因此只负责画，
 * store 与媒体桥接见 `shortsSeekPlayer.ts`。
 */

/** 视觉轨道粗细（px）。与 `SHORTS_SEEK_BAR_HEIGHT_PX` 同值，也是命中层的高度基准。 */
const TRACK_HEIGHT_PX = 3;

/**
 * 预览宽度（px）。
 *
 * 取 160 是因为 B 站快照雪碧图的单格就是 160×90：`ThumbnailCore.resize` 会按容器的
 * `max-width` 反推缩放，给足 160 就得到 1:1 的原始格，不会出现雪碧图偏移被小数倍率
 * 放大成半像素错位（相邻格漏进来一条边）。它同时是这个气泡的宽度基准 ——
 * `SliderPreview` 自己把气泡夹在轨道内，不再需要页面算偏移。
 *
 * 下面两处 `160px` 类名必须同时改：`min-w-[160px]` 给气泡定宽（它里面全是绝对定位的
 * 子元素，`width: max-content` 会量到 0），`max-w-[160px]` 给 `ThumbnailCore` 定约束。
 * 写成字面量而不是插值：Tailwind 只扫源码里的静态类，拼出来的类名不会被生成。
 */
const PREVIEW_WIDTH_PX = 160;

export interface ShortsTimeSliderProps extends Omit<TimeSliderPrimitive.RootProps, "children"> {
  /** 快照雪碧图铺出的整表，直接交给 `Slider.Thumbnail.Root`。 */
  thumbnails: ThumbnailImage[];
}

export function ShortsTimeSlider({ className, thumbnails, ...props }: ShortsTimeSliderProps) {
  return (
    <TimeSliderPrimitive.Root
      // 外层就是命中层：原语的指针处理挂在根节点上，因此它必须比视觉轨道高得多。
      // 由调用方定位（贴底、撑到 20px），这里只保证横向铺满、纵向到底。
      className={(state) =>
        cn(
          "group/slider relative flex w-full cursor-pointer touch-none items-end select-none outline-hidden",
          "data-disabled:pointer-events-none",
          resolveClassName(className, state),
        )
      }
      {...props}
    >
      {/*
        轨道贴在命中层的底边（`items-end`）：它就是底栏与画面的分界线，替掉了原来那条
        `border-t`。

        缓冲区间放在填充之下：低透明度一条，用来读「还能往哪拖」。两个都靠 CSS 变量
        `--media-slider-*`（原语写在根节点上）裁剪，拖动时直接切到 pointer 值。
      */}
      <TimeSliderPrimitive.Track
        className="relative isolate w-full overflow-hidden bg-white/25"
        style={{ height: `${TRACK_HEIGHT_PX}px` }}
      >
        <TimeSliderPrimitive.Buffer
          className={
            "pointer-events-none absolute inset-y-0 left-0 w-full bg-white/15 data-[orientation=horizontal]:clip-media-x-[--media-slider-buffer]"
          }
        />
        <TimeSliderPrimitive.Fill
          className={
            "pointer-events-none absolute inset-y-0 left-0 w-full bg-white/85 data-[orientation=horizontal]:clip-media-x-[--media-slider-fill] group-data-dragging/slider:data-[orientation=horizontal]:clip-media-x-[--media-slider-pointer]"
          }
        />
      </TimeSliderPrimitive.Track>
      {/*
        拖动手柄。默认藏起来：静止时这里是一条细线，不该有额外装饰；指针交互、拖动与
        键盘聚焦（`data-interactive`）时才出现。

        `top` 写死成轨道中心而不是让基类居中：命中层 20px，轨道只有 3px 贴在底边，
        基类的 `top-1/2` 会把圆点浮到轨道上方。`-translate-y-1/2` 保持竖直居中于这一点。
      */}
      <TimeSliderPrimitive.Thumb
        className={cn(
          "absolute z-10 left-(--media-slider-fill) size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-media-thumb",
          "opacity-0 transition-[opacity,scale] duration-media-slider ease-out data-interactive:opacity-100",
          "group-data-dragging/slider:left-(--media-slider-pointer) group-data-dragging/slider:scale-90",
          "outline-transparent outline-4 -outline-offset-4 focus-visible:outline-current/15",
        )}
        style={{ top: `calc(100% - ${TRACK_HEIGHT_PX / 2}px)` }}
      />
      {/*
        预览气泡：时间文本 + 可选缩略图。

        `SliderPreview` 负责定位（按指针位置水平跟随、`overflow="clamp"` 默认夹在轨道
        内），因此这里不必再算左偏移 —— 旧实现里的 `shortsSeekPreviewLeft` 就是它。
        宽度用 `min-w` 钉到 160：气泡内容全是绝对定位的子元素，自身 `width: max-content`
        会量到 0，夹取就会算错。

        悬停（`data-pointing`）与拖动都显示，与播放页一致。时间文本不依赖缩略图能否
        加载：没图时 `Thumbnail.Root` 带 `data-hidden` 消失，这里就剩一个紧凑的时间气泡。
      */}
      <TimeSliderPrimitive.Preview
        className="group/preview relative h-[3px] min-w-[160px]"
        // 只给预览定位容器一个最小宽度（= PREVIEW_WIDTH_PX），夹取才能算对。
        style={{ minWidth: `${PREVIEW_WIDTH_PX}px` }}
      >
        <div
          className={cn(
            "pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 flex -translate-x-1/2 flex-col items-center gap-1",
            "origin-bottom scale-media-hidden-preview opacity-0 transition-[opacity,scale] duration-media-base ease-out",
            "group-data-pointing/preview:scale-100 group-data-pointing/preview:opacity-100",
            "keyboard-nav:group-has-focus-visible/slider:scale-100 keyboard-nav:group-has-focus-visible/slider:opacity-100",
          )}
        >
          <Slider.Thumbnail.Root
            thumbnails={thumbnails}
            className={cn(
              // `max-w-[160px]` = PREVIEW_WIDTH_PX：`ThumbnailCore` 按它反推出 1:1 的格子。
              "pointer-events-none max-w-[160px] overflow-hidden rounded-sm bg-black/60 shadow-media-thumb ring-1 ring-white/20",
              // 没有缩略图（未加载或稿件无快照）时整块让位，只留下面的时间文本。
              "data-hidden:hidden",
            )}
          >
            <Slider.Thumbnail.Image className="block" />
          </Slider.Thumbnail.Root>
          <span className="rounded-sm bg-black/75 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
            <TimeSliderPrimitive.Value type="pointer" />
          </span>
        </div>
      </TimeSliderPrimitive.Preview>
    </TimeSliderPrimitive.Root>
  );
}
