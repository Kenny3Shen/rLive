import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ClipboardCheck,
  ClipboardCopy,
  FolderOpen,
  RefreshCw,
  ScrollText,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { formatByteSize } from "@/lib/utils";
import { getClientPlatform } from "@/shared/clientPlatform";
import { invokeCmd } from "@/shared/api/tauri";
import { FieldTip } from "./FieldTip";

/** 一个日志文件的尾部，对应 `commands::diagnostics::LogFileContent`。 */
export type LogFileContent = {
  path: string;
  exists: boolean;
  size_bytes: number;
  truncated: boolean;
  text: string;
};

export type AppLogSnapshot = {
  directory: string;
  current: LogFileContent;
  previous: LogFileContent;
};

const APP_LOG_QUERY_KEY = ["app-log-snapshot"] as const;

function logErrorMessage(cause: unknown): string {
  return typeof cause === "object" && cause && "message" in cause
    ? String((cause as { message: string }).message)
    : String(cause);
}

async function appLogSnapshot(): Promise<AppLogSnapshot> {
  return invokeCmd<AppLogSnapshot>("app_log_snapshot");
}

async function clearAppLog(): Promise<void> {
  return invokeCmd<void>("app_log_clear");
}

/** 查看器当前显示的是两个文件中的哪一个。 */
type LogTab = "current" | "previous";

/**
 * “关于”面板的日志查看器。
 *
 * Windows 发布版没有控制台，`rlive.log` 是用户反馈失败时唯一能引用的记录。
 * 该日志在设计上只记录失败 —— `init_logging` 绝不写 Cookie 值、token 或聊天文本 ——
 * 因此在这里展示它不会暴露凭据。
 */
export function AppLogField() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<LogTab>("current");
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealing, setRevealing] = useState(false);
  // 日志目录只能在桌面外壳中打开浏览。
  const canReveal = getClientPlatform() === "desktop";

  const snapshot = useQuery({
    queryKey: APP_LOG_QUERY_KEY,
    queryFn: appLogSnapshot,
    // 只有对话框真正在展示该文件时才读取它。
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const clear = useMutation({
    mutationFn: clearAppLog,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: APP_LOG_QUERY_KEY });
    },
  });

  const active = tab === "current" ? snapshot.data?.current : snapshot.data?.previous;
  const hasPrevious = snapshot.data?.previous.exists ?? false;
  const text = active?.text.trimEnd() ?? "";

  async function copyLogText() {
    if (!text) return;
    setActionError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (cause) {
      setActionError(`复制失败：${logErrorMessage(cause)}`);
    }
  }

  async function revealLogDirectory() {
    const directory = snapshot.data?.directory;
    if (!directory || revealing) return;
    setActionError(null);
    setRevealing(true);
    try {
      await revealItemInDir(directory);
    } catch (cause) {
      setActionError(`无法显示日志目录：${logErrorMessage(cause)}`);
    } finally {
      setRevealing(false);
    }
  }

  async function clearLogFiles() {
    if (clear.isPending) return;
    setActionError(null);
    setStatus(null);
    try {
      await clear.mutateAsync();
      setTab("current");
      setStatus("已清空日志文件。重现问题后再回到这里查看新记录。");
    } catch (cause) {
      setActionError(`清空失败：${logErrorMessage(cause)}`);
    }
  }

  const loadError = snapshot.error ? `读取失败：${logErrorMessage(snapshot.error)}` : null;
  const error = actionError ?? loadError;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          // 重新打开时应显示当前文件和干净的状态行。
          setTab("current");
          setActionError(null);
          setStatus(null);
        }
      }}
    >
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle id="app-log-title">
            <span>运行日志</span>
            <FieldTip>
              仅记录警告和错误，不含 Cookie、账号凭据和弹幕内容。反馈问题时可复制这里的内容。
            </FieldTip>
          </FieldTitle>
        </FieldContent>
        <DialogTrigger
          render={
            <Button variant="outline" aria-describedby="app-log-title">
              <ScrollText data-icon="inline-start" aria-hidden />
              查看
            </Button>
          }
        />
      </Field>

      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>运行日志</DialogTitle>
          <DialogDescription>
            {snapshot.data?.directory ? (
              <span className="break-all">{snapshot.data.directory}</span>
            ) : (
              "正在读取日志目录…"
            )}
          </DialogDescription>
        </DialogHeader>

        {hasPrevious && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={tab === "current" ? "secondary" : "ghost"}
              onClick={() => setTab("current")}
            >
              当前日志
            </Button>
            <Button
              type="button"
              size="sm"
              variant={tab === "previous" ? "secondary" : "ghost"}
              onClick={() => setTab("previous")}
            >
              上一份日志
            </Button>
          </div>
        )}

        <div className="min-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3">
          {snapshot.isPending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden />
              正在读取日志…
            </div>
          ) : text ? (
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
              {text}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {active?.exists
                ? "日志文件为空，说明运行期间没有记录到警告或错误。"
                : "还没有日志文件，说明运行期间没有记录到警告或错误。"}
            </p>
          )}
        </div>

        {active?.truncated && (
          <FieldDescription role="status" aria-live="polite">
            文件较大（{formatByteSize(active.size_bytes)}
            ），此处只显示末尾部分；完整内容请打开日志目录查看。
          </FieldDescription>
        )}
        {error ? (
          <FieldError role="alert">{error}</FieldError>
        ) : (
          status && (
            <FieldDescription role="status" aria-live="polite">
              {status}
            </FieldDescription>
          )
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void snapshot.refetch()}
            disabled={snapshot.isFetching || clear.isPending}
          >
            {snapshot.isFetching ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" aria-hidden />
            )}
            刷新
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyLogText()}
            disabled={!text || snapshot.isFetching}
          >
            {copied ? (
              <ClipboardCheck data-icon="inline-start" aria-hidden />
            ) : (
              <ClipboardCopy data-icon="inline-start" aria-hidden />
            )}
            {copied ? "已复制" : "复制"}
          </Button>
          {canReveal && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void revealLogDirectory()}
              disabled={!snapshot.data?.directory || revealing}
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
            onClick={() => void clearLogFiles()}
            disabled={clear.isPending || snapshot.isFetching}
          >
            {clear.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Trash2 data-icon="inline-start" aria-hidden />
            )}
            {clear.isPending ? "正在清空…" : "清空"}
          </Button>
          {/* 与旁边四个操作按钮相同的 outline 变体与 `sm` 尺寸；
              其他所有对话框也都用 outline 按钮关闭。 */}
          <DialogCloseButton size="sm">关闭</DialogCloseButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
