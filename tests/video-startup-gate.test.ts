import { describe, expect, test } from "bun:test";
import {
  canReleaseExistingVideoSource,
  canReleaseVideoMedia,
  initialVideoStartupState,
  releaseVideoStartupState,
  revealVideoChromeState,
  videoStartupSessionKey,
} from "../src/features/video/useVideoStartupGate";

describe("VOD 启动闸门", () => {
  test("取流身份包含内容、画质、音轨、重建轮次和真实代理地址", () => {
    const base = {
      videoKey: "BV1:101",
      qualityQn: 80,
      audioOnly: false,
      playerRevision: 0,
      playUrl: "http://127.0.0.1:1/a.mpd",
    };
    const key = videoStartupSessionKey(base);
    expect(videoStartupSessionKey({ ...base, qualityQn: 64 })).not.toBe(key);
    expect(videoStartupSessionKey({ ...base, audioOnly: true })).not.toBe(key);
    expect(videoStartupSessionKey({ ...base, playerRevision: 1 })).not.toBe(key);
    expect(videoStartupSessionKey({ ...base, playUrl: "http://127.0.0.1:2/b.mpd" })).not.toBe(key);
  });

  test("媒体放行后控制层仍关闭，下一阶段才打开", () => {
    const key = "current";
    const initial = initialVideoStartupState(key);
    const media = releaseVideoStartupState(initial, key);
    expect(media).toEqual({ sessionKey: key, mediaReady: true, chromeReady: false });
    expect(revealVideoChromeState(media, key)).toEqual({
      sessionKey: key,
      mediaReady: true,
      chromeReady: true,
    });
  });

  test("旧会话迟到事件不能放行新会话", () => {
    const current = initialVideoStartupState("new");
    expect(releaseVideoStartupState(current, "old")).toBe(current);
    expect(revealVideoChromeState(initialVideoStartupState("new"), "old")).toEqual(current);
  });

  test("未先放行媒体时不能只挂控制层", () => {
    const initial = initialVideoStartupState("current");
    expect(revealVideoChromeState(initial, "current")).toBe(initial);
  });

  test("同地址查询结算后沿用健康媒体，pending、placeholder 或换源都不放行", () => {
    const healthy = {
      activeSource: "http://127.0.0.1:1/a.mpd",
      activeKind: "dash",
      playUrl: "http://127.0.0.1:1/a.mpd",
      playKind: "dash",
      queryFetching: false,
      placeholder: false,
      mediaReady: false,
      readyState: 2,
      mediaError: false,
    };
    expect(canReleaseExistingVideoSource(healthy)).toBe(true);
    expect(canReleaseExistingVideoSource({ ...healthy, queryFetching: true })).toBe(false);
    expect(canReleaseExistingVideoSource({ ...healthy, placeholder: true })).toBe(false);
    expect(canReleaseExistingVideoSource({ ...healthy, playUrl: "http://127.0.0.1:2/b.mpd" })).toBe(
      false,
    );
    expect(canReleaseExistingVideoSource({ ...healthy, playKind: "native" })).toBe(false);
    expect(canReleaseExistingVideoSource({ ...healthy, readyState: 1 })).toBe(false);
    expect(canReleaseExistingVideoSource({ ...healthy, mediaError: true })).toBe(false);
  });

  test("暂停纯音频恢复位置时，seeked 或后续 canplay 在 ready 后统一放行", () => {
    const pausedAudio = {
      sessionMatchesTarget: true,
      querySettled: true,
      activeSourceMatches: true,
      readyState: 1,
      mediaSeeking: false,
      mediaError: false,
      positionReady: false,
      initialSeekPending: true,
    };

    // metadata/canplay 前先挡住，随后应用续播 seek；不能在 seek 完成前露控制层。
    expect(canReleaseVideoMedia(pausedAudio)).toBe(false);
    expect(
      canReleaseVideoMedia({
        ...pausedAudio,
        readyState: 4,
        mediaSeeking: true,
        positionReady: true,
      }),
    ).toBe(false);

    // seeked 先到但数据尚未回到可播状态：仍等待后续 canplay。
    expect(
      canReleaseVideoMedia({
        ...pausedAudio,
        initialSeekPending: false,
      }),
    ).toBe(false);
    expect(
      canReleaseVideoMedia({
        ...pausedAudio,
        readyState: 4,
        positionReady: true,
        initialSeekPending: false,
      }),
    ).toBe(true);

    expect(
      canReleaseVideoMedia({
        ...pausedAudio,
        readyState: 4,
        positionReady: true,
        initialSeekPending: false,
        sessionMatchesTarget: false,
      }),
    ).toBe(false);
  });
});
