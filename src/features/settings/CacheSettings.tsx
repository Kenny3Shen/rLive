import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { formatByteSize } from "@/lib/utils";
import { invokeCmd } from "@/shared/api/tauri";

export type CacheUsage = {
  bytes: number;
  files: number;
  path: string;
};

export const CACHE_USAGE_QUERY_KEY = ["image-cache-usage"] as const;

function cacheErrorMessage(cause: unknown): string {
  return typeof cause === "object" && cause && "message" in cause
    ? String((cause as { message: string }).message)
    : String(cause);
}

async function cacheUsage(): Promise<CacheUsage> {
  return invokeCmd<CacheUsage>("cache_usage");
}

async function clearCache(): Promise<CacheUsage> {
  return invokeCmd<CacheUsage>("cache_clear");
}

export function ImageCacheField() {
  const queryClient = useQueryClient();
  const [clearStatus, setClearStatus] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const usage = useQuery({
    queryKey: CACHE_USAGE_QUERY_KEY,
    queryFn: cacheUsage,
    staleTime: 5_000,
  });
  const clear = useMutation({
    mutationFn: clearCache,
    onSuccess: (next) => {
      queryClient.setQueryData(CACHE_USAGE_QUERY_KEY, next);
    },
  });

  async function clearImageCache() {
    if (clear.isPending) return;
    const previous = usage.data;
    setClearError(null);
    setClearStatus(null);
    try {
      await clear.mutateAsync();
      setClearStatus(
        `已清除本地图片缓存（${previous?.files ?? 0} 个文件，${formatByteSize(previous?.bytes ?? 0)}）。当前已显示的图片会保留到下次启动。`,
      );
    } catch (cause) {
      setClearError(`清除失败：${cacheErrorMessage(cause)}`);
    }
  }

  const error = clearError ?? (usage.error ? `读取失败：${cacheErrorMessage(usage.error)}` : null);

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldContent>
        <FieldTitle>图片缓存</FieldTitle>
        <FieldDescription>
          头像、封面和分类图标会保存在本地，跨应用重启复用，最多保留 30 天。
        </FieldDescription>
        {usage.data && (
          <FieldDescription role="status" aria-live="polite">
            已缓存 {usage.data.files} 个文件，占用 {formatByteSize(usage.data.bytes)}
          </FieldDescription>
        )}
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          clearStatus && (
            <FieldDescription role="status" aria-live="polite">
              {clearStatus}
            </FieldDescription>
          )
        )}
      </FieldContent>
      <div className="flex shrink-0 items-center self-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void clearImageCache()}
          disabled={usage.isPending || clear.isPending}
        >
          {clear.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Trash2 data-icon="inline-start" aria-hidden />
          )}
          {clear.isPending ? "正在清除…" : "清除缓存"}
        </Button>
      </div>
    </Field>
  );
}
