import { describe, expect, test } from "bun:test";
import { createPlaybackClock } from "../src/features/video/videoPlaybackClock";
import {
  isVideoPlayerTimeQuiet,
  REGISTERED_MEDIA,
} from "../src/components/videojs/lib/player-time-quiet";
import {
  disposeVideoExitQuiet,
  hasQuietVideoPlayerForExit,
  quietVideoPlayerForExit,
  releaseVideoExitQuiet,
  type VideoExitQuiet,
} from "../src/features/video/videoExitQuiet";

function fixture() {
  const clock = createPlaybackClock(10);
  const media = { currentTime: 10 } as HTMLVideoElement;
  const quietStates: boolean[] = [];
  const quiet: VideoExitQuiet = {
    clock,
    videoRef: { current: media },
    danmakuRendererRef: {
      current: { setQuiet: (next) => quietStates.push(next) },
    },
  };
  let clockNotifications = 0;
  clock.subscribe(() => clockNotifications++);
  return {
    quiet,
    media,
    quietStates,
    get clockNotifications() {
      return clockNotifications;
    },
    get clockTime() {
      return clock.get();
    },
  };
}

describe("VOD 离场播放时钟静默", () => {
  test("同步静默 Player store 写入，挂起业务时钟与弹幕投放", () => {
    const { quiet, media, quietStates } = fixture();
    const restore = quietVideoPlayerForExit(quiet);
    expect(isVideoPlayerTimeQuiet(media)).toBe(true);
    expect(quietStates).toEqual([true]);
    expect(quiet.clock.get()).toBe(10);
    expect(hasQuietVideoPlayerForExit()).toBe(true);
    restore();
  });

  test("Player media facade 与真实元素共用同一份静默标记", () => {
    const { quiet, media } = fixture();
    const restore = quietVideoPlayerForExit(quiet);
    const facade = { [REGISTERED_MEDIA]: media } as unknown as HTMLVideoElement;
    expect(isVideoPlayerTimeQuiet(facade)).toBe(true);
    restore();
    expect(isVideoPlayerTimeQuiet(facade)).toBe(false);
  });

  test("导航未离页时恢复监听，并补发静默期间的真实媒体位置", () => {
    const state = fixture();
    const restore = quietVideoPlayerForExit(state.quiet);
    state.quiet.clock.set(12);
    state.quiet.videoRef.current = { currentTime: 18 } as HTMLVideoElement;
    expect(state.clockNotifications).toBe(0);
    restore();
    expect(isVideoPlayerTimeQuiet(state.media)).toBe(false);
    expect(isVideoPlayerTimeQuiet(state.quiet.videoRef.current)).toBe(false);
    expect(state.quietStates).toEqual([true, false]);
    expect(state.clockTime).toBe(18);
    expect(state.clockNotifications).toBe(1);
    state.quiet.clock.set(18.25);
    expect(state.clockNotifications).toBe(2);
    expect(hasQuietVideoPlayerForExit()).toBe(false);
    restore();
  });

  test("媒体事件已更新到真实位置时，恢复仍补发一次时钟通知", () => {
    const state = fixture();
    const restore = quietVideoPlayerForExit(state.quiet);
    state.media.currentTime = 12;
    state.quiet.clock.set(12);
    expect(state.clockNotifications).toBe(0);
    restore();
    expect(state.clockTime).toBe(12);
    expect(state.clockNotifications).toBe(1);
    restore();
    expect(state.clockNotifications).toBe(1);
  });

  test("同一播放页重复返回只挂起一次", () => {
    const state = fixture();
    quietVideoPlayerForExit(state.quiet);
    const restore = quietVideoPlayerForExit(state.quiet);
    expect(isVideoPlayerTimeQuiet(state.media)).toBe(true);
    restore();
  });

  test("离场后异步建立的弹幕实例在重新进入时也恢复调度", () => {
    const state = fixture();
    state.quiet.danmakuRendererRef.current = null;
    const restore = quietVideoPlayerForExit(state.quiet);
    const changes: boolean[] = [];
    state.quiet.danmakuRendererRef.current = { setQuiet: (next) => changes.push(next) };
    restore();
    expect(changes).toEqual([false]);
    expect(isVideoPlayerTimeQuiet(state.media)).toBe(false);
  });

  test("真正卸载时清理挂起，不留下静默媒体标记", () => {
    const state = fixture();
    quietVideoPlayerForExit(state.quiet);
    state.quiet.clock.set(12);
    disposeVideoExitQuiet(state.quiet);
    releaseVideoExitQuiet(state.quiet);
    expect(isVideoPlayerTimeQuiet(state.media)).toBe(false);
    expect(state.quietStates).toEqual([true]);
    expect(state.clockNotifications).toBe(0);
    expect(hasQuietVideoPlayerForExit()).toBe(false);
  });

  test("多个离场播放页分别静默，恢复其中一个不影响另一个", () => {
    const first = fixture();
    const second = fixture();
    const restoreFirst = quietVideoPlayerForExit(first.quiet);
    const restoreSecond = quietVideoPlayerForExit(second.quiet);
    expect(isVideoPlayerTimeQuiet(first.media)).toBe(true);
    expect(isVideoPlayerTimeQuiet(second.media)).toBe(true);
    restoreFirst();
    expect(isVideoPlayerTimeQuiet(first.media)).toBe(false);
    expect(isVideoPlayerTimeQuiet(second.media)).toBe(true);
    expect(hasQuietVideoPlayerForExit()).toBe(true);
    restoreSecond();
    expect(hasQuietVideoPlayerForExit()).toBe(false);
  });
});
