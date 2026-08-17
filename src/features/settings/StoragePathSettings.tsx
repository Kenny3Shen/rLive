import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderCog, FolderOpen, RotateCcw } from "lucide-react";
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
import {
  RECORDINGS_QUERY_KEY,
  RECORDING_STORAGE_QUERY_KEY,
  recordingErrorMessage,
  recordingStorageInfo,
  recordingSupported,
  setRecordingStoragePath,
} from "@/features/recording/recording";
import {
  appDataStorageInfo,
  setAppDataStoragePath,
  type AppDataStorageInfo,
} from "./appDataStorage";

const APP_DATA_STORAGE_QUERY_KEY = ["app-data-storage"] as const;

type StoragePathControlProps = {
  id: string;
  title: string;
  description: string;
  path: string;
  defaultPath: string;
  isDefault: boolean;
  unavailable?: boolean;
  action: "choose" | "reset" | "reveal" | null;
  error: string | null;
  status?: string | null;
  onChoose: () => void;
  onReset: () => void;
  onReveal: () => void;
};

function StoragePathControl({
  id,
  title,
  description,
  path,
  defaultPath,
  isDefault,
  unavailable = false,
  action,
  error,
  status,
  onChoose,
  onReset,
  onReveal,
}: StoragePathControlProps) {
  const busy = action !== null;
  return (
    <Field data-invalid={error ? true : undefined} data-disabled={unavailable ? true : undefined}>
      <FieldContent>
        <FieldTitle>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
        <InputGroup className="mt-2">
          <InputGroupInput
            id={id}
            aria-label={`${title}路径`}
            value={path}
            placeholder={unavailable ? "仅桌面客户端支持自定义路径" : "正在读取…"}
            title={path || undefined}
            readOnly
            disabled={unavailable}
          />
        </InputGroup>
        {defaultPath && !isDefault && (
          <FieldDescription className="break-all">默认位置：{defaultPath}</FieldDescription>
        )}
        {error ? (
          <FieldError role="alert">{error}</FieldError>
        ) : (
          status && (
            <FieldDescription role="status" aria-live="polite" className="break-all">
              {status}
            </FieldDescription>
          )
        )}
      </FieldContent>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReset}
          disabled={unavailable || busy || isDefault}
        >
          {action === "reset" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RotateCcw data-icon="inline-start" aria-hidden />
          )}
          恢复默认
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReveal}
          disabled={unavailable || busy || !path}
        >
          {action === "reveal" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <FolderOpen data-icon="inline-start" aria-hidden />
          )}
          显示目录
        </Button>
        <Button type="button" size="sm" onClick={onChoose} disabled={unavailable || busy}>
          {action === "choose" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <FolderCog data-icon="inline-start" aria-hidden />
          )}
          更改位置
        </Button>
      </div>
    </Field>
  );
}

export function RecordingStoragePathField() {
  const queryClient = useQueryClient();
  const supported = recordingSupported();
  const [action, setAction] = useState<StoragePathControlProps["action"]>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const storage = useQuery({
    queryKey: RECORDING_STORAGE_QUERY_KEY,
    enabled: supported,
    queryFn: recordingStorageInfo,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const update = useMutation({
    mutationFn: setRecordingStoragePath,
    onSuccess: (info) => {
      queryClient.setQueryData(RECORDING_STORAGE_QUERY_KEY, info);
      void queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
    },
  });
  const info = storage.data;
  const error = actionError ?? (storage.error ? recordingErrorMessage(storage.error) : null);

  async function choose() {
    if (!supported || action) return;
    setAction("choose");
    setActionError(null);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择录制保存位置",
        defaultPath: info?.path,
      });
      if (typeof selected === "string") await update.mutateAsync(selected);
    } catch (cause) {
      setActionError(`无法更新录制保存位置：${recordingErrorMessage(cause)}`);
    } finally {
      setAction(null);
    }
  }

  async function reset() {
    if (!supported || action || info?.is_default) return;
    setAction("reset");
    setActionError(null);
    try {
      await update.mutateAsync(null);
    } catch (cause) {
      setActionError(`无法恢复默认录制位置：${recordingErrorMessage(cause)}`);
    } finally {
      setAction(null);
    }
  }

  async function reveal() {
    if (!info?.path || action) return;
    setAction("reveal");
    setActionError(null);
    try {
      await revealItemInDir(info.path);
    } catch (cause) {
      setActionError(`无法显示录制目录：${recordingErrorMessage(cause)}`);
    } finally {
      setAction(null);
    }
  }

  return (
    <StoragePathControl
      id="recording-storage-path"
      title="录制保存位置"
      description="视频、录制元数据和弹幕轨保存在此目录。更改位置不会移动已有录制。"
      path={info?.path ?? ""}
      defaultPath={info?.default_path ?? ""}
      isDefault={info?.is_default ?? true}
      unavailable={!supported}
      action={action}
      error={error}
      onChoose={() => void choose()}
      onReset={() => void reset()}
      onReveal={() => void reveal()}
    />
  );
}

export function AppDataStoragePathField() {
  const supported = recordingSupported();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<StoragePathControlProps["action"]>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const storage = useQuery({
    queryKey: APP_DATA_STORAGE_QUERY_KEY,
    enabled: supported,
    queryFn: appDataStorageInfo,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const update = useMutation({
    mutationFn: setAppDataStoragePath,
    onSuccess: (info) =>
      queryClient.setQueryData<AppDataStorageInfo>(APP_DATA_STORAGE_QUERY_KEY, info),
  });
  const info = storage.data;
  const error = actionError ?? (storage.error ? recordingErrorMessage(storage.error) : null);

  function updateStatus(next: AppDataStorageInfo) {
    setStatus(
      next.restartRequired
        ? `已保存。当前仍使用 ${next.currentPath}，重启 rLive 后切换到新位置。`
        : "应用数据保存位置已更新。",
    );
  }

  async function choose() {
    if (!supported || action) return;
    setAction("choose");
    setActionError(null);
    setStatus(null);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择应用数据保存位置",
        defaultPath: info?.path,
      });
      if (typeof selected === "string") updateStatus(await update.mutateAsync(selected));
    } catch (cause) {
      setActionError(`无法更新应用数据保存位置：${recordingErrorMessage(cause)}`);
    } finally {
      setAction(null);
    }
  }

  async function reset() {
    if (!supported || action || info?.isDefault) return;
    setAction("reset");
    setActionError(null);
    setStatus(null);
    try {
      updateStatus(await update.mutateAsync(null));
    } catch (cause) {
      setActionError(`无法恢复默认应用数据位置：${recordingErrorMessage(cause)}`);
    } finally {
      setAction(null);
    }
  }

  async function reveal() {
    if (!info || action) return;
    setAction("reveal");
    setActionError(null);
    try {
      await revealItemInDir(info.restartRequired ? info.path : info.currentPath);
    } catch (cause) {
      setActionError(`无法显示应用数据目录：${recordingErrorMessage(cause)}`);
    } finally {
      setAction(null);
    }
  }

  return (
    <StoragePathControl
      id="app-data-storage-path"
      title="应用数据保存位置"
      description="数据库、设置、日志、本地模型和默认录制目录保存在此位置。变更将在重启后生效，不会自动移动当前目录中的已有数据。"
      path={info?.path ?? ""}
      defaultPath={info?.defaultPath ?? ""}
      isDefault={info?.isDefault ?? true}
      unavailable={!supported}
      action={action}
      error={error}
      status={status}
      onChoose={() => void choose()}
      onReset={() => void reset()}
      onReveal={() => void reveal()}
    />
  );
}
