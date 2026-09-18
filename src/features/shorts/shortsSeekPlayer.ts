import { useEffect } from "react";
import type { RefObject } from "react";
import { createPlayer, useMediaAttach } from "@videojs/react";
import { bufferFeature, timeFeature } from "@videojs/core/dom";

/**
 * 短视频进度条专用的最小播放器 store。
 *
 * Video.js 的 `TimeSlider` 原语直接读播放器 store：没有 `timeFeature` 时它连根节点都
 * 不渲染（`root.js` 里 `if (!time) return null`）。短视频的传输是自有的
 * `VideoJsPlayer` + dash.js，不经过 Video.js 的媒体适配器，因此另起一个只带进度条
 * 需要的两个 feature 的 store，再用 `ShortsSeekBridge` 把**活动槽位**的 `<video>`
 * 桥接进去。
 *
 * 为什么不直接复用 `ShortsPosterPlayer`：那份带的是封面需要的 `playbackFeature` /
 * `metadataFeature`，`TimeSlider` 要的 `timeFeature` / `bufferFeature` 一个都没有。
 * 两者各带各的 feature，而不是拼成一个四 feature 的大 store —— 槽位有三个，每个
 * feature 的 attach 都会往媒体元素上挂一组监听，拼在一起等于三份白付的监听。
 *
 * 为什么不复用播放页的 `videoFeatures`：那套含画质、音轨、全屏、PiP、字幕、直播
 * 边沿……竖屏舞台一条都用不上，每个 feature 还要在 attach 时挂监听。
 */
export const ShortsSeekPlayer = createPlayer({
  features: [timeFeature, bufferFeature],
  displayName: "rLiveShortsSeek",
}).Player;

/**
 * 把活动槽位的 `<video>` 接进 `ShortsSeekPlayer`。
 *
 * `useMediaAttach` 是 Player 作用域里的 media setter（内部就是 store.attach 的入口），
 * 这里把它当成一个「指向外的 ref」用：槽位的媒体元素跨换片存活，因此不能像
 * `<Video>` 那样在元素上用 ref 注册（那个只能接当前渲染出来的那一个），而是由页面
 * 告诉它「现在是这个槽位」。
 *
 * 必须渲染在 `ShortsSeekPlayer` 之内、槽位面板之外：面板里还有一层
 * `ShortsPosterPlayer`，渲染在它里面会被最近的那个 Player 上下文截走。
 *
 * 换槽位时新旧两个 effect 的回调在同一个提交里执行：React 先跑所有清理（旧的
 * `setMedia(null)`）再跑所有 setup（新的 `setMedia(el)`），因此 store 不会停在
 * 旧元素上。
 */
export function ShortsSeekBridge({
  videoRef,
  active,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 活动槽位标识：变化即重新桥接。 */
  active: string;
}) {
  const setMedia = useMediaAttach();
  useEffect(() => {
    const media = videoRef.current;
    if (!media) return;
    setMedia?.(media);
    return () => setMedia?.(null);
    // `active` 与 `videoRef` 任一变化都要重接；`active` 单独列出是因为两次变更之间
    // 可能恰好落到同一个 ref 对象上（槽位轮转时不会，但依赖写全更稳）。
  }, [active, setMedia, videoRef]);
  return null;
}
