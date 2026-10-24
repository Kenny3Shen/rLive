import { describe, expect, test } from "bun:test";
import { watchHlsMediaProgress } from "../src/features/room/player/hlsMediaWatch";

class ProgressMedia extends EventTarget {
  paused = false;
  readyState = 4;
  seeking = false;
  currentTime = 10;

  advance(seconds: number) {
    this.currentTime += seconds;
    this.dispatchEvent(new Event("timeupdate"));
  }
}

function setup(isCurrent = () => true) {
  const media = new ProgressMedia();
  const progress: number[] = [];
  const interrupted: number[] = [];
  const stop = watchHlsMediaProgress(
    media,
    () => progress.push(media.currentTime),
    () => interrupted.push(media.currentTime),
    isCurrent,
  );
  return { media, progress, interrupted, stop };
}

describe("HLS 媒体进展监听", () => {
  test("只有 currentTime 实际前进且可播放时才通知进展", () => {
    const state = setup();

    state.media.dispatchEvent(new Event("timeupdate"));
    expect(state.progress).toEqual([]);

    state.media.advance(1);
    expect(state.progress).toEqual([11]);

    state.media.readyState = 1;
    state.media.advance(1);
    expect(state.progress).toEqual([11]);
    // timeupdate 不推进计时，但打断事实由 waiting/pause/seeking 负责。
    expect(state.interrupted).toEqual([]);
  });

  test("非有限 currentTime 不污染后续进展基线", () => {
    const state = setup();

    state.media.currentTime = Number.NaN;
    state.media.dispatchEvent(new Event("timeupdate"));
    state.media.currentTime = 20;
    state.media.dispatchEvent(new Event("timeupdate"));
    expect(state.progress).toEqual([20]);
  });

  test("暂停不累计进展", () => {
    const state = setup();

    state.media.paused = true;
    state.media.advance(1);
    expect(state.progress).toEqual([]);
    expect(state.interrupted).toEqual([]);
  });

  test("seeking 后首个合格 timeupdate 只重对齐基线，下一前进才计进展", () => {
    const state = setup();

    state.media.paused = false;
    state.media.dispatchEvent(new Event("seeking"));
    state.media.seeking = true;
    // 跳变发生在 seeking 期间，但不发 timeupdate。
    state.media.currentTime = 40;
    state.media.seeking = false;
    state.media.dispatchEvent(new Event("timeupdate"));
    // seeking 期间未到达 timeupdate 时，首个合格事件仍只重对齐。
    expect(state.progress).toEqual([]);
    expect(state.interrupted).toHaveLength(1);

    state.media.advance(1);
    expect(state.progress).toEqual([41]);
  });

  test("暂停或未就绪的 timeupdate 只更新基线，不消费重对齐标记", () => {
    const state = setup();

    state.media.dispatchEvent(new Event("seeking"));
    state.media.paused = true;
    state.media.advance(5);
    state.media.paused = false;
    state.media.readyState = 1;
    state.media.advance(5);
    expect(state.progress).toEqual([]);

    state.media.readyState = 4;
    state.media.seeking = true;
    state.media.advance(5);
    state.media.seeking = false;
    state.media.dispatchEvent(new Event("timeupdate"));
    expect(state.progress).toEqual([]);
    state.media.advance(1);
    expect(state.progress).toEqual([26]);
  });

  test("waiting/pause 事件打断，非当前播放器与卸载后不回调", () => {
    let current = true;
    const state = setup(() => current);

    state.media.dispatchEvent(new Event("waiting"));
    state.media.dispatchEvent(new Event("pause"));
    expect(state.interrupted).toHaveLength(2);

    current = false;
    state.media.advance(1);
    state.media.dispatchEvent(new Event("seeking"));
    expect(state.progress).toEqual([]);
    expect(state.interrupted).toHaveLength(2);

    current = true;
    state.stop();
    state.media.advance(1);
    expect(state.progress).toEqual([]);
  });
});
