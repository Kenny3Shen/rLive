import { useCallback, useState } from "react";

/**
 * 首次可播后再加载弹幕、侧栏等辅助内容；调用方在失败时也放行，避免恢复入口一直空着。
 * 放行记录绑定内容身份：换房/换片当次渲染即关闭，旧媒体的迟到回调不能放行新内容。
 * 暂停、缓冲和同内容重连不关闸，也不卸载用户已经打开的面板。
 */
export function usePlayerStartupGate(contentKey: string) {
  const [state, setState] = useState({ key: contentKey, generation: 0, ready: false });
  if (state.key !== contentKey) {
    setState({ key: contentKey, generation: state.generation + 1, ready: false });
  }
  const generation = state.generation;
  const release = useCallback(
    () =>
      setState((current) =>
        current.key === contentKey && current.generation === generation && !current.ready
          ? { ...current, ready: true }
          : current,
      ),
    [contentKey, generation],
  );
  return { ready: state.key === contentKey && state.ready, release };
}
