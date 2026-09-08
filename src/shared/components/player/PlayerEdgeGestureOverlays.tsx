import type { Ref } from "react";
import { SunMedium, Volume2 } from "lucide-react";
import type { PlayerEdgeGestureFeedbackRefs } from "@/shared/hooks/usePlayerEdgeGesture";

/**
 * 亮度兜底罩：调暗只需要 alpha 合成。整面 CSS brightness 滤镜会在浏览器/桥
 * 兜底播放中于每一步手势时对视频和弹幕层重复滤波。
 *
 * 由 `usePlayerEdgeGesture` 的 `brightnessShadeRef` 驱动，Android 原生桥可用时
 * 恒为透明（亮度由 Activity 承担）。
 */
export function PlayerBrightnessShade({ ref }: { ref: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      data-player-brightness-shade
      className="pointer-events-none absolute inset-0 z-[11] bg-black opacity-0"
      aria-hidden="true"
    />
  );
}

/**
 * 亮度/音量手势的画面内数值反馈卡。文本与进度条由手势逐帧命令式写入
 * （见 `usePlayerEdgeGesture`），这里只提供节点与自然态样式。
 */
export function PlayerEdgeGestureFeedback({ refs }: { refs: PlayerEdgeGestureFeedbackRefs }) {
  return (
    <div
      ref={refs.root}
      aria-hidden="true"
      data-kind="brightness"
      data-player-edge-gesture-feedback="brightness"
      data-visible="false"
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center opacity-0 [will-change:opacity]"
    >
      <div
        ref={refs.panel}
        className="flex w-44 max-w-[calc(100%-2rem)] flex-col gap-3 rounded-lg border border-white/12 bg-black/78 p-3 text-white shadow-xl [transform:scale(0.97)] [will-change:transform]"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/12">
            <SunMedium ref={refs.brightnessIcon} className="size-5" />
            <Volume2 ref={refs.volumeIcon} className="size-5" style={{ display: "none" }} />
          </span>
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
            <span ref={refs.label} className="text-sm text-white/76">
              亮度
            </span>
            <strong ref={refs.value} className="text-base font-semibold tabular-nums">
              100%
            </strong>
          </span>
        </div>
        <span className="h-1 overflow-hidden rounded-full bg-white/20">
          <span
            ref={refs.progress}
            className="block h-full origin-left rounded-full bg-white [transform:scaleX(1)] [will-change:transform]"
          />
        </span>
      </div>
    </div>
  );
}
