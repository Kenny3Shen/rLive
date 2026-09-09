import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { usePlayerChromeIdle } from "../../src/shared/hooks/usePlayerChromeIdle";

/**
 * 真实 `usePlayerChromeIdle` 的浏览器夹具：舞台处理器与 VideoPlayerPage 逐字同构，
 * 由 `tests/player-chrome-leave.browser.js` 用真实鼠标与触摸事件驱动，验证
 * 「鼠标移出播放器区域立即收起」契约：
 *   - 鼠标离开 → HUD 与控制条立即收起（不等 2s 空闲倒计时）；
 *   - 触摸指针抬手触发的 pointerleave → 回落到空闲倒计时，不吞掉点按唤醒的 chrome；
 *   - keepVisible（暂停/缓冲/失败/弹层）与键盘焦点守卫在离场路径上同样生效。
 */

type ChromeLeaveApi = {
  setKeepVisible: (value: boolean) => void;
};

declare global {
  interface Window {
    __chromeLeave?: ChromeLeaveApi;
  }
}

function ChromeStage({ onApi }: { onApi: (api: ChromeLeaveApi) => void }) {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef<HTMLDivElement | null>(null);
  const [keepVisible, setKeepVisible] = useState(false);
  const { revealControls, holdControlsVisible, scheduleControlsHide, dismissControls } =
    usePlayerChromeIdle({
      controlsRef,
      hudRef,
      lockRef,
      fullscreenLocked: false,
      keepVisible,
    });

  const handleStagePointerActivity = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest("[data-player-controls]")) {
        holdControlsVisible();
        return;
      }
      revealControls();
    },
    [holdControlsVisible, revealControls],
  );

  const handleStagePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") {
        scheduleControlsHide();
        return;
      }
      dismissControls();
    },
    [dismissControls, scheduleControlsHide],
  );

  useEffect(() => {
    onApi({ setKeepVisible });
  }, [onApi]);

  return (
    <div
      data-player-stage
      onPointerEnter={handleStagePointerActivity}
      onPointerMove={handleStagePointerActivity}
      onPointerLeave={handleStagePointerLeave}
    >
      <div ref={hudRef} data-player-hud data-visible="true" aria-hidden={false}>
        <button type="button">HUD 按钮</button>
      </div>
      <div ref={controlsRef} data-player-controls data-visible="true" aria-hidden={false}>
        <button type="button">控制按钮</button>
      </div>
      <div ref={lockRef} data-player-fullscreen-lock data-visible="true" aria-hidden={false} />
    </div>
  );
}

const host = document.getElementById("fixture");
if (!host) throw new Error("缺少 #fixture 挂载点");
createRoot(host).render(
  <ChromeStage
    onApi={(api) => {
      window.__chromeLeave = api;
    }}
  />,
);
