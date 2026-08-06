import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform, type ClientPlatform } from "@/shared/clientPlatform";

export type AsrModelState =
  | "not_downloaded"
  | "downloaded"
  | "downloading"
  | "extracting"
  | "loading"
  | "ready"
  | "error"
  | "unsupported";

export type AsrModelStatus = {
  state: AsrModelState;
  downloaded_bytes: number;
  total_bytes: number | null;
  model_size_bytes: number;
  speaker_enabled: boolean;
  vad_enabled: boolean;
  punctuation_enabled: boolean;
  hotwords_count: number;
  speaker_model_downloaded: boolean;
  speaker_model_size_bytes: number;
  threads: number;
  provider: "cpu" | "cuda";
  message: string | null;
};

export type AsrStatusPresentation = {
  message: string;
  busy: boolean;
  error: boolean;
  progress: number | null;
};

export const ASR_MODEL_STATUS_QUERY_KEY = ["asr_model_status"] as const;

export function supportsLocalAsr(environment?: {
  tauriRuntime?: boolean;
  platform?: ClientPlatform;
}): boolean {
  const tauriRuntime = environment?.tauriRuntime ?? isTauri();
  const platform = environment?.platform ?? getClientPlatform();
  return tauriRuntime && (platform === "desktop" || platform === "android");
}

export function asrDownloadProgress(status: AsrModelStatus | null): number | null {
  if (
    !status ||
    status.state !== "downloading" &&
    status.state !== "extracting"
  ) {
    return null;
  }
  const total = status.total_bytes ?? status.model_size_bytes;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((status.downloaded_bytes / total) * 100)));
}

export function formatAsrBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gibibyte = 1024 ** 3;
  if (bytes >= gibibyte) return `${(bytes / gibibyte).toFixed(2)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function describeAsrModelStatus(
  status: AsrModelStatus | null,
  options: { enabled: boolean; supported: boolean; queryError?: string | null },
): AsrStatusPresentation {
  if (!options.supported) {
    return {
      message: "语音字幕当前仅支持 Tauri 桌面或 Android 客户端",
      busy: false,
      error: false,
      progress: null,
    };
  }
  if (options.queryError) {
    return {
      message: `模型状态读取失败：${options.queryError}`,
      busy: false,
      error: true,
      progress: null,
    };
  }
  if (!status) {
    return {
      message: "正在检查本地模型…",
      busy: true,
      error: false,
      progress: null,
    };
  }
  if (!options.enabled) {
    const retained = status.state === "ready" || status.state === "downloaded";
    return {
      message: retained ? "功能已关闭，本地模型会保留" : "关闭时不会下载模型",
      busy: false,
      error: false,
      progress: null,
    };
  }

  const progress = asrDownloadProgress(status);
  switch (status.state) {
    case "not_downloaded":
      return { message: "等待下载模型…", busy: true, error: false, progress: 0 };
    case "downloaded":
      return { message: "模型已下载，正在等待加载…", busy: true, error: false, progress: 100 };
    case "downloading": {
      const total = status.total_bytes ?? status.model_size_bytes;
      const detail = `${formatAsrBytes(status.downloaded_bytes)} / ${formatAsrBytes(total)}`;
      return {
        message: `${status.message ?? "正在下载模型…"} ${progress ?? 0}%（${detail}）`,
        busy: true,
        error: false,
        progress,
      };
    }
    case "extracting":
      return {
        message: status.message ?? "正在后台解压字幕模型…",
        busy: true,
        error: false,
        progress: progress ?? 0,
      };
    case "loading":
      return { message: "模型已下载，正在加载…", busy: true, error: false, progress: 100 };
    case "ready": {
      const features = [
        status.vad_enabled ? "VAD" : "关闭 VAD",
        status.punctuation_enabled ? "自动标点" : "原始文本",
        status.speaker_enabled ? "说话人区分" : null,
        status.hotwords_count > 0 ? `${status.hotwords_count} 个热词` : null,
      ].filter((value): value is string => value !== null);
      return {
        message: `Zipformer 中英双语模型已就绪（${status.provider === "cuda" ? "NVIDIA CUDA" : "CPU"} / ${status.threads} 线程 + ${features.join(" + ")}）${status.message ? `；${status.message}` : ""}`,
        busy: false,
        error: false,
        progress: 100,
      };
    }
    case "error":
      return {
        message: status.message ?? "模型准备失败，请重试",
        busy: false,
        error: true,
        progress: null,
      };
    case "unsupported":
      return {
        message: status.message ?? "语音字幕当前仅支持 Tauri 桌面或 Android 客户端",
        busy: false,
        error: false,
        progress: null,
      };
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function useAsrModelStatus(options: { enabled: boolean; autoPrepare?: boolean }) {
  const queryClient = useQueryClient();
  const supported = supportsLocalAsr();
  const autoPrepare = options.autoPrepare ?? true;
  const attemptedStateRef = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ASR_MODEL_STATUS_QUERY_KEY,
    enabled: supported,
    staleTime: 0,
    refetchOnMount: "always",
    retry: 1,
    queryFn: () => invokeCmd<AsrModelStatus>("asr_get_status"),
    refetchInterval: (currentQuery) => {
      if (!options.enabled) return false;
      const state = currentQuery.state.data?.state;
      if (
        !state ||
        state === "downloading" ||
        state === "extracting" ||
        state === "loading"
      ) {
        return 500;
      }
      return state === "ready" ? 5_000 : false;
    },
  });

  const prepare = useCallback(async () => {
    if (!supported) {
      throw new Error("语音字幕当前仅支持 Tauri 桌面或 Android 客户端");
    }
    attemptedStateRef.current = null;
    const status = await invokeCmd<AsrModelStatus>("asr_enable");
    queryClient.setQueryData(ASR_MODEL_STATUS_QUERY_KEY, status);
    return status;
  }, [queryClient, supported]);

  useEffect(() => {
    if (!supported || !autoPrepare || !options.enabled) {
      attemptedStateRef.current = null;
      return;
    }
    const status = query.data;
    if (!status || (status.state !== "not_downloaded" && status.state !== "downloaded")) return;
    const attemptKey = `${status.state}:${status.downloaded_bytes}`;
    if (attemptedStateRef.current === attemptKey) return;
    attemptedStateRef.current = attemptKey;
    void prepare().catch(() => {});
  }, [autoPrepare, options.enabled, prepare, query.data, supported]);

  return {
    supported,
    status: query.data ?? null,
    queryError: query.error ? errorMessage(query.error) : null,
    isPending: query.isPending,
    prepare,
    refetch: query.refetch,
  };
}
