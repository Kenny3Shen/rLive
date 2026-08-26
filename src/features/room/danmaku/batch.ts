import type { DanmakuEvent } from "@/shared/types/live";
import { isDanmakuEvent } from "./filter";

/** 原生弹幕传输以有节奏的批次发出的负载。 */
export type DanmakuBatch = {
  connection_epoch: number;
  events: DanmakuEvent[];
};

export type ValidatedDanmakuBatch = {
  connectionEpoch: number;
  events: DanmakuEvent[];
};

/**
 * Tauri 事件跨越原生边界，因此在任何房间 sink 迭代原始事件候选之前，
 * 先拒绝畸形信封。
 */
export function batchEvents(payload: unknown): readonly unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const events = (payload as { events?: unknown }).events;
  return Array.isArray(events) ? events : [];
}

/**
 * 在房间边界处对原生批次校验一次。悬浮 DOM 层、聊天与 SC 叠加层随后可以消费
 * 同一批不可变事件对象，而不必每条消息都重复片段与字段检查。
 */
export function validatedBatchEvents(payload: unknown): DanmakuEvent[] {
  const valid: DanmakuEvent[] = [];
  for (const event of batchEvents(payload)) {
    if (isDanmakuEvent(event)) valid.push(event);
  }
  return valid;
}

/**
 * 在预校验事件旁保留原生连接围栏。正被断开的房间发来的最后一批数据，
 * 绝不能被恰好共用同一 Tauri 事件通道的新挂载房间渲染出来。
 */
export function validatedDanmakuBatch(payload: unknown): ValidatedDanmakuBatch | null {
  if (!payload || typeof payload !== "object") return null;
  const connectionEpoch = (payload as { connection_epoch?: unknown }).connection_epoch;
  if (
    typeof connectionEpoch !== "number" ||
    !Number.isSafeInteger(connectionEpoch) ||
    connectionEpoch < 0
  ) {
    return null;
  }

  return { connectionEpoch, events: validatedBatchEvents(payload) };
}
