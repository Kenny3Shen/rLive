import { useCallback, useEffect, useRef } from "react";
import { getClientPlatform } from "@/shared/clientPlatform";
import {
  beginFullscreenTransition,
  frozenSafeAreaTopValue,
  shouldFreezeFullscreenInsets,
  FULLSCREEN_TRANSITION_TIMEOUT_MS,
} from "@/shared/fullscreenTransition";

/**
 * 进入全屏的整个过渡期间钉住 `.app-shell` 的安全区内边距（见
 * `shared/fullscreenTransition` 里对两种全屏实现为何都需要它的说明）。
 *
 * 直播播放器与录制/视频播放器各自持有全屏状态机，但过渡期的外壳回流问题完全
 * 相同，因此冻结/释放这对操作放在这里共享 —— 两处分别实现会让其中一处漏掉
 * 超时兜底或卸载清理，而症状（聊天或详情区在画面铺满前抖几帧）只在真机可见。
 */
export function useFullscreenInsetFreeze() {
  const freezeRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);

  const release = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    freezeRef.current?.();
    freezeRef.current = null;
  }, []);

  const freeze = useCallback(() => {
    if (typeof document === "undefined") return;
    if (!shouldFreezeFullscreenInsets(getClientPlatform())) return;
    // 用户快速连续切换两次时上一次冻结可能仍然打开。先释放它，
    // 保证始终至多一个未决冻结。
    release();
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const root = document.documentElement;
    if (!shell || !root) return;
    // 钉住外壳已有的内边距而不是猜测值，使冻结成为真正的保持：
    // 安装的那一刻布局不得移动。
    const frozen = frozenSafeAreaTopValue(window.getComputedStyle(shell).paddingTop);
    if (!frozen) return;
    freezeRef.current = beginFullscreenTransition(root, frozen);
    // 兜底 WebView 不触发 fullscreenchange 就 resolve 请求的情况，
    // 使冻结绝不能比这次交互活得更久。
    timerRef.current = window.setTimeout(release, FULLSCREEN_TRANSITION_TIMEOUT_MS);
  }, [release]);

  // 没有任何东西可以比播放器活得更久：过渡中途的路由变更否则会把外壳
  // 钉在过期的内边距上。
  useEffect(() => release, [release]);

  return { freeze, release };
}
