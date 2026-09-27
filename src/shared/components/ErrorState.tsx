import { AlertCircle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import type { AppError } from "@/shared/types/error";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ErrorStateProps = {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
  /**
   * 错误有明确的下一步（如凭据失效需重新授权）时渲染的额外操作。
   *
   * 与 `onRetry` 并列而不是替换它：重试对可恢复失败仍然有效，
   * 恢复入口只是多给一个确定能解决问题的路径。
   */
  action?: ReactNode;
};

function messageFromError(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as AppError).message);
  }
  if (error instanceof Error) return error.message;
  return String(error ?? "未知错误");
}

function codeFromError(error: unknown): string | null {
  if (typeof error === "object" && error && "code" in error) {
    return String((error as AppError).code);
  }
  return null;
}

export function ErrorState({
  error,
  onRetry,
  title = "出了点问题",
  className,
  action,
}: ErrorStateProps) {
  const message = messageFromError(error);
  const code = codeFromError(error);

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-xl border border-danger/25 bg-danger/10 px-4 py-5",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
        <div>
          <h2 className="text-sm font-semibold text-danger">{title}</h2>
          <p className="mt-1 text-sm text-danger/90">{message}</p>
          {code && <p className="mt-1 font-mono text-xs text-danger/70">{code}</p>}
        </div>
      </div>
      {(onRetry || action) && (
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && (
            <Button variant="destructive" size="sm" onClick={onRetry}>
              <RotateCcw data-icon="inline-start" />
              重试
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
