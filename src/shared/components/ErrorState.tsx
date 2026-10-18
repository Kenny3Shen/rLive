import { AlertCircle, ChevronDown, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { errorPresentation } from "./errorPresentation";

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

/**
 * 统一的错误卡。
 *
 * 说明区只放面向用户的短句：上游返回的 HTML、URL 与多行堆栈收进「技术详情」，
 * 需要时再展开（判定见 `errorPresentation`）。原始文案不做删改 —— 排查问题时
 * 它才是唯一可靠的证据，只是不该占满整张卡片。长串使用 `break-all` 并限制在
 * 可滚动的预格式块里，避免无断点的 URL 把所在侧栏撑出屏幕。
 */
export function ErrorState({
  error,
  onRetry,
  title = "出了点问题",
  className,
  action,
}: ErrorStateProps) {
  const { description, technical } = errorPresentation(error);

  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn(
        "flex min-w-0 flex-col items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-4",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-destructive">{title}</h2>
          <p className="mt-1 break-words text-sm text-destructive/90 [overflow-wrap:anywhere]">
            {description}
          </p>
        </div>
      </div>
      {(onRetry || action) && (
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && (
            <Button variant="destructive" size="sm" onClick={onRetry}>
              <RotateCcw data-icon="inline-start" aria-hidden />
              重试
            </Button>
          )}
          {action}
        </div>
      )}
      {technical && (
        <Collapsible className="w-full min-w-0">
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                // `group` 落在触发器本身：`data-panel-open` 由 base-ui 写在按钮上，
                // 图标是它的后代，只能靠祖先选择器旋转（写在图标上永远命中不了）。
                className="group h-auto gap-1 px-0 py-0.5 text-xs font-normal text-destructive/75 hover:bg-transparent hover:text-destructive"
              />
            }
          >
            <ChevronDown
              className="transition-transform group-data-[panel-open]:rotate-180 motion-reduced:transition-none"
              data-icon="inline-start"
              aria-hidden
            />
            技术详情
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1.5 max-h-40 w-full overflow-auto rounded-md bg-background/60 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
              {technical}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
