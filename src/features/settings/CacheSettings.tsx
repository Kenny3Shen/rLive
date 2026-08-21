import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { formatByteSize } from "@/lib/utils";
import { getClientPlatform } from "@/shared/clientPlatform";
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  // The cache directory only exists as a browsable folder on desktop shells.
  const canReveal = getClientPlatform() === "desktop";
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
  const path = usage.data?.path ?? "";

  async function clearImageCache() {
    if (clear.isPending) return;
    const previous = usage.data;
    setActionError(null);
    setClearStatus(null);
    try {
      await clear.mutateAsync();
      setClearStatus(
        `已清除本地图片缓存（${previous?.files ?? 0} 个文件，${formatByteSize(previous?.bytes ?? 0)}）。当前已显示的图片会保留到下次启动。`,
      );
    } catch (cause) {
      setActionError(`清除失败：${cacheErrorMessage(cause)}`);
    }
  }

  async function revealCacheDirectory() {
    if (!path || revealing) return;
    setActionError(null);
    setRevealing(true);
    try {
      await revealItemInDir(path);
    } catch (cause) {
      setActionError(`无法显示缓存目录：${cacheErrorMessage(cause)}`);
    } finally {
      setRevealing(false);
    }
  }

  const error = actionError ?? (usage.error ? `读取失败：${cacheErrorMessage(usage.error)}` : null);

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldContent>
        <FieldTitle>图片缓存</FieldTitle>
        <FieldDescription>
          头像和分类图标会保存在本地，跨应用重启复用，最多保留 30
          天。直播封面不入缓存，每次浏览都取最新画面。
        </FieldDescription>
        <InputGroup className="mt-2">
          <InputGroupInput
            id="image-cache-path"
            aria-label="图片缓存目录"
            value={path}
            placeholder="正在读取…"
            title={path || undefined}
            readOnly
          />
        </InputGroup>
        {usage.data && (
          <FieldDescription role="status" aria-live="polite">
            已缓存 {usage.data.files} 个文件，占用 {formatByteSize(usage.data.bytes)}
          </FieldDescription>
        )}
        {error ? (
          <FieldError role="alert">{error}</FieldError>
        ) : (
          clearStatus && (
            <FieldDescription role="status" aria-live="polite">
              {clearStatus}
            </FieldDescription>
          )
        )}
      </FieldContent>
      <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">
        {canReveal && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void revealCacheDirectory()}
            disabled={!path || revealing || clear.isPending}
          >
            {revealing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <FolderOpen data-icon="inline-start" aria-hidden />
            )}
            显示目录
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void clearImageCache()}
          disabled={usage.isPending || clear.isPending || revealing}
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
