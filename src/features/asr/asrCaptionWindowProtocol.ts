import type { AsrTranscriptEntry, AsrTranscriptLive } from "./asrTranscript";

/**
 * 主窗口与独立字幕窗口之间的通道定义。
 *
 * 独立窗口只加载同一前端 bundle，不渲染路由；`main_window_only` 会拒绝它调用
 * 任何应用命令，因此两边只能通过事件通信。事件名、窗口 label 与载荷类型都
 * 收在这里，避免桥接模块被新窗口整包引入。
 */

export const ASR_CAPTION_WINDOW_LABEL = "asr-captions";

export const ASR_CAPTION_EVENT = {
  /** 新窗口完成事件订阅后发出，主窗口收到后补发快照。 */
  ready: "asr-captions://ready",
  /** 全量转录，用于建窗、窗口重载与迟到的 ready。 */
  snapshot: "asr-captions://snapshot",
  /** 逐条追加（定稿行或房间分隔条）。 */
  append: "asr-captions://append",
  /** 按条目 id 回填译文。 */
  patch: "asr-captions://patch",
  /** 房间标题、开关、在途假设与错误提示。 */
  live: "asr-captions://live",
  /** 字幕窗口请求清空历史；主窗口清空转录后回发一份空快照。 */
  clear: "asr-captions://clear",
} as const;

export type AsrCaptionSnapshotPayload = {
  entries: readonly AsrTranscriptEntry[];
  live: AsrTranscriptLive;
};

export type AsrCaptionAppendPayload = {
  entry: AsrTranscriptEntry;
};

export type AsrCaptionPatchPayload = {
  id: string;
  translation: string;
};

export type AsrCaptionLivePayload = {
  live: AsrTranscriptLive;
};
