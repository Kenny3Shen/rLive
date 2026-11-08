import { setVideoPlayerTimeQuiet } from "@/components/videojs/lib/player-time-quiet";

/**
 * 播放页离场期间的播放时钟静默。
 *
 * 返回按钮先发起导航，PageZoom 仍会让旧播放页和它的活跃 `<video>` 活到退场
 * 动画结束。此时 Video.js 的逐帧时间 feature、媒体事件同步与业务播放时钟仍
 * 照常通知 `useSyncExternalStore`；同步外部 store 更新会打断 React 的并发导航
 * 渲染，让列表页迟迟无法提交。这里只暂停「把时间变化发布给 React」这一步：
 * 媒体元素、媒体时间、MSE 源和已解码画面全部保留，离场动画照常显示活画面。
 */
/** 弹幕渲染器只需要在离场时停掉自己的 rAF 投放循环。 */
export type QuietableDanmakuRenderer = {
  setQuiet: (quiet: boolean) => void;
};

export type QuietablePlaybackClock = {
  set: (seconds: number) => void;
  setQuiet: (quiet: boolean, notifyOnResume?: boolean) => void;
};

export type PlayerExitQuiet = {
  clock?: QuietablePlaybackClock;
  videoRef: { current: HTMLVideoElement | null };
  danmakuRendererRef?: { current: QuietableDanmakuRenderer | null };
};

type ActiveQuiet = {
  media: HTMLVideoElement;
  restore: () => void;
};

// 快速往返时多个离场层可短暂共存，各自保持静默，直到恢复或卸载。
const active = new Map<PlayerExitQuiet, ActiveQuiet>();

/**
 * 在导航回调里同步挂起高频时间发布。返回的恢复函数幂等，供导航被守卫拒绝或
 * 快速返回后重新进入当前页时使用；真正离页由 `disposeVideoExitQuiet` 清理。
 */
export function quietPlayerForExit(quiet: PlayerExitQuiet): () => void {
  const existing = active.get(quiet);
  if (existing) return existing.restore;
  const media = quiet.videoRef.current;
  if (!media) return () => {};
  const renderer = quiet.danmakuRendererRef?.current;

  let released = false;
  const restore = () => {
    if (released) return;
    released = true;
    if (active.get(quiet)?.restore !== restore) return;
    active.delete(quiet);
    renderer?.setQuiet(false);
    const latestRenderer = quiet.danmakuRendererRef?.current;
    if (latestRenderer !== renderer) latestRenderer?.setQuiet(false);
    setVideoPlayerTimeQuiet(media, false);
    // 静默期间媒体仍在播放；补发真实位置，让进度条和弹幕列表从当前位置继续。
    if (quiet.videoRef.current) quiet.clock?.set(quiet.videoRef.current.currentTime);
    quiet.clock?.setQuiet(false);
  };

  quiet.clock?.setQuiet(true);
  renderer?.setQuiet(true);
  // 在 time feature 的写入边界拦下同步 store 发布；媒体、监听器与已绑定
  // 的 Player store 都保持原状，离场画面不会闪出暂停或缓冲状态。
  setVideoPlayerTimeQuiet(media, true);
  active.set(quiet, { media, restore });
  return restore;
}

/** 导航未真正发生时恢复时间发布。 */
export function releasePlayerExitQuiet(quiet: PlayerExitQuiet): void {
  active.get(quiet)?.restore();
}

/** 页面即将卸载：不再向已经失效的 Player store 重接媒体。 */
export function disposePlayerExitQuiet(quiet: PlayerExitQuiet): void {
  const current = active.get(quiet);
  if (!current) return;
  active.delete(quiet);
  // 卸载不补发订阅通知，也不重启即将销毁的弹幕调度。
  quiet.clock?.setQuiet(false, false);
  setVideoPlayerTimeQuiet(current.media, false);
}

/** 测试辅助：不读取页面私有状态，只报告当前是否还有未释放的挂起。 */
export function hasQuietPlayerForExit(): boolean {
  return active.size > 0;
}

/** 在 Router 的状态发布边界静默媒体，早于目标页的并发 React 提交。 */
export function watchPlayerRouteExit(
  router: {
    state: { location: { key: string } };
    subscribe: (listener: (state: { location: { key: string } }) => void) => () => void;
  },
  entryKey: string,
  quiet: PlayerExitQuiet,
): () => void {
  const sync = (state: { location: { key: string } }) => {
    if (state.location.key === entryKey) releasePlayerExitQuiet(quiet);
    else quietPlayerForExit(quiet);
  };
  sync(router.state);
  const unsubscribe = router.subscribe(sync);
  return () => {
    unsubscribe();
    disposePlayerExitQuiet(quiet);
  };
}
