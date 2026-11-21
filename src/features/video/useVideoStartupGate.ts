import { useCallback, useEffect, useState } from "react";

export type VideoStartupState = {
  sessionKey: string;
  mediaReady: boolean;
  chromeReady: boolean;
};

export type VideoStartupSession = {
  videoKey: string;
  qualityQn: number | null;
  audioOnly: boolean;
  playerRevision: number;
  playUrl: string | undefined;
};

/**
 * 一轮 VOD 取流会话的稳定身份。
 *
 * `playUrl` 是代理会话的实际身份；画质、音轨形态和重建轮次也进入身份，
 * 使重试在拿到新地址之前的旧媒体事件不能放行新一轮。
 */
export function videoStartupSessionKey(session: VideoStartupSession): string {
  return JSON.stringify([
    session.videoKey,
    session.qualityQn,
    session.audioOnly,
    session.playerRevision,
    session.playUrl ?? null,
  ]);
}

export function initialVideoStartupState(sessionKey: string): VideoStartupState {
  return { sessionKey, mediaReady: false, chromeReady: false };
}

/**
 * 标记媒体已可绘制。旧会话迟到的回调只能命中自己的 key，不能打开新会话。
 */
export function releaseVideoStartupState(
  state: VideoStartupState,
  sessionKey: string,
): VideoStartupState {
  if (state.sessionKey !== sessionKey || state.mediaReady) return state;
  return { ...state, mediaReady: true };
}

/** 首帧已经提交一个帧周期后，才允许控制栏和详情界面进入布局。 */
export function revealVideoChromeState(
  state: VideoStartupState,
  sessionKey: string,
): VideoStartupState {
  if (state.sessionKey !== sessionKey || !state.mediaReady || state.chromeReady) return state;
  return { ...state, chromeReady: true };
}

/**
 * 查询拿到同一播放地址后，能否沿用已经健康的媒体实例。
 *
 * placeholder 或仍在请求中的旧结果不能放行新一轮；只有查询结算、地址与当前
 * 绑定源一致且媒体没有错误时，才可只打开闸门而不重绑 `<video>`。
 */
export function canReleaseExistingVideoSource({
  activeSource,
  activeKind,
  playUrl,
  playKind,
  queryFetching,
  placeholder,
  mediaReady,
  readyState,
  mediaError,
}: {
  activeSource: string | null;
  activeKind: string | null;
  playUrl: string | undefined;
  playKind: string;
  queryFetching: boolean;
  placeholder: boolean;
  mediaReady: boolean;
  readyState: number;
  mediaError: boolean;
}): boolean {
  return (
    !mediaReady &&
    !queryFetching &&
    !placeholder &&
    Boolean(playUrl) &&
    activeSource === playUrl &&
    activeKind === playKind &&
    !mediaError &&
    readyState >= 2
  );
}

/**
 * 当前媒体会话是否已经真正可播，可打开 VOD 外围界面。
 *
 * `readyState` 会在恢复续播位置的 seek 过程中短暂回落，而且暂停媒体不会再
 * 触发 `playing`。因此必须同时要求查询与绑定会话仍匹配、位置已经恢复，并等
 * 初始 seek 完成；之后由任意可播事件再次调用即可，不依赖自动播放事件。
 */
export function canReleaseVideoMedia({
  sessionMatchesTarget,
  querySettled,
  activeSourceMatches,
  readyState,
  mediaSeeking,
  mediaError,
  positionReady,
  initialSeekPending,
}: {
  sessionMatchesTarget: boolean;
  querySettled: boolean;
  activeSourceMatches: boolean;
  readyState: number;
  mediaSeeking: boolean;
  mediaError: boolean;
  positionReady: boolean;
  initialSeekPending: boolean;
}): boolean {
  return (
    sessionMatchesTarget &&
    querySettled &&
    activeSourceMatches &&
    readyState >= 2 &&
    !mediaSeeking &&
    !mediaError &&
    positionReady &&
    !initialSeekPending
  );
}

/**
 * 点播首帧的两级放行。
 *
 * `mediaReady` 负责启动辅助请求，`chromeReady` 再晚一个渲染帧，负责挂载
 * 控制栏、视频信息和操作按钮。所有状态都绑定完整取流身份，画质、音轨、
 * 重试或代理地址变化会同步关闭，旧实例的事件不能误放行。
 */
export function useVideoStartupGate(sessionKey: string) {
  const [state, setState] = useState(() => initialVideoStartupState(sessionKey));
  if (state.sessionKey !== sessionKey) {
    setState(initialVideoStartupState(sessionKey));
  }
  const current = state.sessionKey === sessionKey ? state : initialVideoStartupState(sessionKey);

  /**
   * 放行函数保持稳定，调用方必须传入自己实际绑定媒体源时捕获的 key。
   *
   * 这样回调身份不会因画质、音轨或重试轮次变化而进入媒体绑定 effect 的依赖；
   * 旧媒体实例只可能尝试放行旧 key，新会话仍保持关闭。
   */
  const release = useCallback((releasedSessionKey: string) => {
    setState((previous) => releaseVideoStartupState(previous, releasedSessionKey));
  }, []);

  useEffect(() => {
    if (!current.mediaReady || current.chromeReady) return;
    let frame: number | null = null;
    let secondFrame: number | null = null;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      // 媒体状态更新与首个画面可能在同一帧提交。再等一个动画帧，让控制层
      // 在画面真正有机会呈现之后进入，而不是与首帧抢同一次绘制。
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = null;
        setState((previous) => revealVideoChromeState(previous, sessionKey));
      });
    });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [current.chromeReady, current.mediaReady, sessionKey]);

  return {
    sessionKey: current.sessionKey,
    mediaReady: current.mediaReady,
    chromeReady: current.chromeReady,
    release,
  };
}
