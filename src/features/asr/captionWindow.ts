import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { asrTranscript } from "./asrTranscript";
import {
  ASR_CAPTION_EVENT,
  ASR_CAPTION_WINDOW_LABEL,
  type AsrCaptionAppendPayload,
  type AsrCaptionLivePayload,
  type AsrCaptionPatchPayload,
  type AsrCaptionSnapshotPayload,
} from "./asrCaptionWindowProtocol";

/**
 * 独立字幕窗口的主窗口侧桥接。
 *
 * 窗口只加载同一前端 bundle，但 Tauri 的 `main_window_only` 会拒绝它调用应用
 * 命令，因此转录只能走事件：新窗口完成订阅后发 `ready`，主窗口补发快照；之后
 * 只在窗口存在期间逐条转发增量。窗口关闭（destroyed）后停止订阅，重新打开或
 * 页面重载会再次收到 `ready` 并重新同步。
 */

/** 主窗口只注册一次 ready 监听；多次建窗共用。 */
let readyListenerPromise: Promise<void> | null = null;
let stopForwarding: (() => void) | null = null;
let opening: Promise<void> | null = null;
/** 事件必须按产生顺序到达，避免译文 patch 先于对应行追加。 */
let emitChain: Promise<void> = Promise.resolve();

function enqueueEmit(event: string, payload: unknown): void {
  emitChain = emitChain
    .then(() => emitTo(ASR_CAPTION_WINDOW_LABEL, event, payload))
    .catch(() => undefined);
}

function sendSnapshot(): void {
  const payload: AsrCaptionSnapshotPayload = {
    entries: asrTranscript.getEntries(),
    live: asrTranscript.getLive(),
  };
  enqueueEmit(ASR_CAPTION_EVENT.snapshot, payload);
}

function startForwarding(): void {
  if (stopForwarding) return;
  stopForwarding = asrTranscript.subscribe((change) => {
    switch (change.kind) {
      case "append": {
        const payload: AsrCaptionAppendPayload = { entry: change.entry };
        enqueueEmit(ASR_CAPTION_EVENT.append, payload);
        break;
      }
      case "patch": {
        const payload: AsrCaptionPatchPayload = {
          id: change.id,
          translation: change.translation,
        };
        enqueueEmit(ASR_CAPTION_EVENT.patch, payload);
        break;
      }
      case "live": {
        const payload: AsrCaptionLivePayload = { live: change.live };
        enqueueEmit(ASR_CAPTION_EVENT.live, payload);
        break;
      }
    }
  });
}

function stopForwardingToWindow(): void {
  stopForwarding?.();
  stopForwarding = null;
}

/**
 * 在新窗口创建前完成注册，防止窗口加载快于监听导致首个 `ready` 丢失。
 * 注册失败时清空 promise，下一次点击可以重试。
 */
function ensureReadyListener(): Promise<void> {
  readyListenerPromise ??= listen(ASR_CAPTION_EVENT.ready, () => {
    // 建窗、窗口重载与迟到的 ready 都走同一条恢复路径：先补全量，再转发增量。
    sendSnapshot();
    startForwarding();
  })
    .then(() => undefined)
    .catch((error: unknown) => {
      readyListenerPromise = null;
      throw error;
    });
  return readyListenerPromise;
}

async function openInternal(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(ASR_CAPTION_WINDOW_LABEL);
  if (existing) {
    // 主窗口热重载后模块状态会重置，而字幕窗口仍开着；此时补一次快照并
    // 恢复转发，不能只聚焦旧窗口。
    await ensureReadyListener();
    sendSnapshot();
    startForwarding();
    await existing.unminimize().catch(() => undefined);
    await existing.setFocus().catch(() => undefined);
    return;
  }

  await ensureReadyListener();
  const window = new WebviewWindow(ASR_CAPTION_WINDOW_LABEL, {
    url: "/",
    title: "直播字幕",
    width: 420,
    height: 600,
    minWidth: 320,
    minHeight: 360,
    resizable: true,
    // 保留系统原生标题栏，窗口可移动、缩放与单独关闭。
    decorations: true,
    center: true,
  });
  void window.once("tauri://destroyed", () => {
    stopForwardingToWindow();
  });
}

/** 打开或聚焦独立字幕窗口；重复点击不会创建第二个实例。 */
export function openAsrCaptionWindow(): Promise<void> {
  opening ??= openInternal().finally(() => {
    opening = null;
  });
  return opening;
}
