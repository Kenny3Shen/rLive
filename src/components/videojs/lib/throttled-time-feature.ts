import { timeFeature } from "@videojs/core/dom";
import { createTimePublishGate, isCurrentTimeOnlyPatch } from "./time-publish-gate";

type TimeAttach = NonNullable<(typeof timeFeature)["attach"]>;

/**
 * 原生 `timeFeature` 的包装：state、`seek` 与事件同步完全沿用 @videojs/core 10.1.0，
 * 只把播放中逐帧的 `set({ currentTime })` 节流到约 10Hz。
 *
 * 进度条和时间文本是 store 时间的唯一消费方；弹幕、ASR、续播上报都直接读
 * `video.currentTime`，不受影响。seek/pause/ended/timeupdate 等事件走完整 `sync`
 * （多字段写入），不经过节流，因此拖动进度、暂停和切集仍即时反映。
 */
export const throttledTimeFeature: typeof timeFeature = {
  ...timeFeature,
  attach(context: Parameters<TimeAttach>[0]) {
    const gate = createTimePublishGate();
    const set: typeof context.set = (patch) => {
      const now = performance.now();
      if (isCurrentTimeOnlyPatch(patch)) {
        if (!gate.shouldPublish(now)) return;
      } else {
        gate.markPublished(now);
      }
      context.set(patch);
    };
    return timeFeature.attach?.({ ...context, set });
  },
};

/** 把 feature 列表中的原生 time feature 换成节流版本，其余 feature 原样保留。 */
export function withThrottledTimeFeature<const Features extends readonly unknown[]>(
  features: Features,
): Features {
  return features.map((feature) =>
    feature === timeFeature ? throttledTimeFeature : feature,
  ) as unknown as Features;
}
