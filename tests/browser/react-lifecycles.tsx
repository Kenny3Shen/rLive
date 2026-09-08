import { act, StrictMode, useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { DanmakuPanel } from "../../src/features/room/DanmakuPanel";
import { DanmakuComposer } from "../../src/features/room/BilibiliDanmakuComposer";
import { setExpectedDanmakuConnectionEpoch } from "../../src/features/room/danmaku/eventBus";
import {
  useAutoDanmakuSend,
  type AutoDanmakuSendController,
} from "../../src/features/room/danmaku/useAutoDanmakuSend";
import type { DanmakuSendStatus } from "../../src/features/room/danmaku/sending";
import { useSettingsStore } from "../../src/shared/stores/settingsStore";
import {
  applyPlayerChromeVisibility,
  usePlayerChromeVisibility,
} from "../../src/shared/hooks/usePlayerChromeVisibility";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ready: DanmakuSendStatus = {
  send_enabled: true,
  cookie_ready: true,
  available: true,
  message: "可发送",
};

/** 真实 React 提交与事件回归；只在独立浏览器测试页运行，所有发送均走模拟 IPC。 */
export async function runReactLifecycleRegressions(host: HTMLElement): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, isTauri: true });
  const initialSettings = useSettingsStore.getState();
  const pendingStatus: ((status: DanmakuSendStatus) => void)[] = [];
  const sends: unknown[] = [];
  mockIPC(
    (command, args) => {
      if (command === "bilibili_danmaku_send_status") {
        return new Promise<DanmakuSendStatus>((resolve) => pendingStatus.push(resolve));
      }
      if (command === "bilibili_danmaku_send") sends.push(args);
      return null;
    },
    { shouldMockEvents: true },
  );
  useSettingsStore.setState({
    danmakuBlockedUsers: [],
    danmakuShieldWords: [],
    danmakuSendEnabled: true,
    danmakuSendPending: false,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  const passed: string[] = [];
  const render = async (node: ReactNode) => {
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>{node}</QueryClientProvider>
        </StrictMode>,
      );
    });
  };
  const resolveStatus = async () => {
    check(pendingStatus.length > 0, "必须重新发起权限检查");
    await act(async () => {
      for (const resolve of pendingStatus.splice(0)) resolve(ready);
    });
  };

  try {
    let renders = 0;
    const visibleRef = { current: true };
    function Chrome({ locked = false, revision = 0 }: { locked?: boolean; revision?: number }) {
      renders += 1;
      const controlsRef = useRef<HTMLDivElement>(null);
      const hudRef = useRef<HTMLDivElement>(null);
      const lockRef = useRef<HTMLDivElement>(null);
      usePlayerChromeVisibility({ controlsRef, hudRef, lockRef, visibleRef, locked });
      return (
        <>
          <div ref={controlsRef} data-test="controls" data-visible="true" aria-hidden={false} />
          <div
            key={revision}
            ref={hudRef}
            data-test="hud"
            data-visible="true"
            aria-hidden={false}
          />
          <div ref={lockRef} data-test="lock" data-visible="true" aria-hidden={false} />
        </>
      );
    }
    await render(<Chrome />);
    const beforeHide = renders;
    visibleRef.current = false;
    applyPlayerChromeVisibility([...host.querySelectorAll<HTMLElement>("[data-test]")], false);
    check(renders === beforeHide, "命令式显隐不得触发 React 重渲染");
    await render(<Chrome revision={1} />);
    for (const element of host.querySelectorAll<HTMLElement>("[data-test]")) {
      check(
        element.dataset.visible === "false" &&
          element.inert &&
          element.getAttribute("aria-hidden") === "true",
        "重渲染与 HUD 重挂载必须保留隐藏状态",
      );
    }
    visibleRef.current = true;
    await render(<Chrome locked />);
    check(
      host.querySelector<HTMLElement>('[data-test="controls"]')?.inert,
      "锁定时控件必须不可交互",
    );
    check(!host.querySelector<HTMLElement>('[data-test="lock"]')?.inert, "锁定按钮必须仍可交互");
    await render(<Chrome />);
    check(
      !host.querySelector<HTMLElement>('[data-test="controls"]')?.inert,
      "解锁必须恢复控件交互",
    );
    passed.push("HUD 命令式隐藏、重挂载、锁定与解锁");

    setExpectedDanmakuConnectionEpoch(1);
    await render(<DanmakuPanel active={false} siteId="bilibili" roomId="1" />);
    await render(<DanmakuPanel active siteId="bilibili" roomId="1" />);
    await act(async () => {
      await emit("danmaku-batch", {
        connection_epoch: 1,
        events: [
          { kind: "chat", user: "甲", content: "测试消息甲", color: null, ts: 1000 },
          { kind: "chat", user: "乙", content: "测试消息乙", color: null, ts: 1001 },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    check(
      host.textContent?.includes("测试消息甲") && host.textContent.includes("测试消息乙"),
      "批次消息必须显示",
    );
    await act(async () => {
      useSettingsStore.setState({ danmakuBlockedUsers: ["甲"] });
    });
    check(
      !host.textContent?.includes("测试消息甲") && host.textContent?.includes("测试消息乙"),
      "屏蔽用户必须即时过滤，函数状态不能被误调用",
    );
    await act(async () => {
      useSettingsStore.setState({ danmakuBlockedUsers: [] });
    });
    check(!host.textContent?.includes("测试消息甲"), "解除屏蔽不得回填已删除消息");
    await render(<DanmakuPanel active={false} />);
    check(!host.textContent?.includes("测试消息乙"), "停用面板必须清空消息");
    passed.push("屏蔽匹配器切换、解除屏蔽与面板停用");

    await render(<DanmakuComposer siteId="bilibili" roomId="1" />);
    await resolveStatus();
    const input = () => host.querySelector<HTMLInputElement>("input");
    check(input() && !input()!.disabled, "授权后允许编辑弹幕");
    await act(async () => {
      useSettingsStore.setState({ danmakuSendPending: true });
    });
    check(input()?.disabled, "权限持久化期间必须禁用输入");
    await act(async () => {
      useSettingsStore.setState({ danmakuSendPending: false });
    });
    check(input()?.disabled, "授权状态恢复后不能复用之前的就绪快照");
    await resolveStatus();
    check(!input()?.disabled, "新权限检查完成后恢复输入");
    await act(async () => {
      useSettingsStore.setState({ danmakuSendEnabled: false });
    });
    check(input()?.disabled, "撤销发送授权必须立即禁用输入");
    await act(async () => {
      useSettingsStore.setState({ danmakuSendEnabled: true });
    });
    check(input()?.disabled, "快速重新授权仍需新检查");
    await resolveStatus();
    passed.push("发送权限等待、撤销及重新授权的快照失效");

    let autoSend: AutoDanmakuSendController | undefined;
    function AutoSend({ roomId }: { roomId: string }) {
      const controller = useAutoDanmakuSend({ siteId: "bilibili", roomId });
      useLayoutEffect(() => {
        autoSend = controller;
      });
      return <output>{controller.statusMessage}</output>;
    }
    await render(<AutoSend roomId="1" />);
    await resolveStatus();
    await act(async () => {
      autoSend!.onTextChange("自动发送测试");
    });
    check(autoSend?.canEnable, "具备权限与文本后应可启用自动发送");
    const setTimeoutBefore = window.setTimeout;
    let staleTimer: (() => void) | undefined;
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof handler === "function" && delay && delay >= 10000)
        staleTimer = () => handler(...args);
      return setTimeoutBefore(handler, delay, ...args);
    }) as typeof window.setTimeout;
    try {
      await act(async () => {
        autoSend!.onEnabledChange(true);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      check(sends.length === 1 && staleTimer, "首段发送后必须排定下一段计时器");
      await render(<AutoSend roomId="2" />);
      check(autoSend?.enabled === false && autoSend.text === "", "换房必须清空自动发送会话");
      await act(async () => {
        staleTimer!();
      });
      check(sends.length === 1, "已经排队的旧房间回调不得再发送");
    } finally {
      window.setTimeout = setTimeoutBefore;
    }
    passed.push("自动发送换房复位与过期计时器围栏");
    return passed;
  } finally {
    await act(async () => {
      root.unmount();
    });
    client.clear();
    useSettingsStore.setState(initialSettings, true);
    clearMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false, isTauri: false });
  }
}
