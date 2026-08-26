import { notify as toast } from "@/components/ui/toast";
import { invokeCmd } from "@/shared/api/tauri";
import {
  IPTV_AVAILABILITY_BATCH_SIZE,
  IPTV_AVAILABILITY_CHECK_LIMIT,
  availabilityStateFromResult,
  getIptvChannelChecks,
  type IptvChannelAvailability,
} from "./availability";
import { useIptvAvailabilityStore } from "./availabilityStore";
import type { IptvChannel } from "./types";

export type IptvAvailabilityProbeOptions = {
  sourceUrl: string;
  /** 只为用户主动触发的运行展示成功/失败 toast。 */
  notify?: boolean;
  /** 即使来源包含数千行也保持启动工作有界。 */
  limit?: number;
};

let probeEpoch = 0;

function messageFromError(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String(error.message);
  }
  if (error instanceof Error) return error.message;
  return String(error ?? "未知错误");
}

/** 更改或替换来源之前先使进行中的探测失效。 */
export function cancelIptvAvailabilityProbe(): void {
  probeEpoch += 1;
  useIptvAvailabilityStore.getState().setProgress(null);
}

/**
 * 探测有界的 IPTV URL 集合并把结果保存在会话缓存中。
 * 纪元守卫使先前来源的迟到响应无害。
 */
export async function probeIptvAvailability(
  channels: readonly IptvChannel[],
  options: IptvAvailabilityProbeOptions,
): Promise<IptvChannelAvailability[] | null> {
  const limit = options.limit ?? IPTV_AVAILABILITY_CHECK_LIMIT;
  const checks = getIptvChannelChecks(channels, limit);
  if (checks.length === 0) return null;

  const store = useIptvAvailabilityStore;
  if (store.getState().sourceUrl !== options.sourceUrl) {
    store.getState().resetForSource(options.sourceUrl);
  }

  const previousAvailability = store.getState().byUrl;
  const runId = ++probeEpoch;
  const results: IptvChannelAvailability[] = [];
  store.getState().setProgress({ completed: 0, total: checks.length });
  store
    .getState()
    .setManyAvailability(
      checks.map((check) => ({ url: check.url, state: { status: "checking" } })),
    );

  try {
    for (let offset = 0; offset < checks.length; offset += IPTV_AVAILABILITY_BATCH_SIZE) {
      const batch = checks.slice(offset, offset + IPTV_AVAILABILITY_BATCH_SIZE);
      const batchResults = await invokeCmd<IptvChannelAvailability[]>("iptv_check_channels", {
        checks: batch,
      });
      if (probeEpoch !== runId) return null;
      results.push(...batchResults);
      store.getState().setManyAvailability(
        batchResults.map((result) => ({
          url: result.url,
          state: availabilityStateFromResult(result),
        })),
      );
      store.getState().setProgress({ completed: results.length, total: checks.length });
    }
  } catch (error) {
    if (probeEpoch !== runId) return null;
    store.getState().revertChecking(
      checks.map((check) => check.url),
      previousAvailability,
    );
    if (options.notify) toast.error("频道可用性检测失败", messageFromError(error));
    return null;
  }

  if (probeEpoch !== runId) return null;
  store.getState().setProgress(null);
  store.getState().markChecked(options.sourceUrl);
  if (options.notify) {
    const availableCount = results.filter((result) => result.available).length;
    const omittedCount = new Set(channels.map((channel) => channel.url)).size - checks.length;
    const limitMessage = omittedCount > 0 ? ` · 已检测前 ${limit} 个` : "";
    toast.success(
      "频道可用性检测完成",
      `${availableCount} 个可用 · ${results.length - availableCount} 个不可用${limitMessage}`,
    );
  }
  return results;
}
