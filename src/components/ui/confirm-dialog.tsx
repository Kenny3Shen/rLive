import type { ReactElement, ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";

type ConfirmDialogProps = {
  /** 透传给 AlertDialog Root。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可选触发元素，以 render 传给 AlertDialogTrigger。 */
  trigger?: ReactElement;
  /** 标题区图标。 */
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  /** 失败提示等信息，渲染在标题区与按钮区之间。 */
  error?: ReactNode;
  cancelText?: ReactNode;
  confirmText: ReactNode;
  /** busy 时确认按钮文案，缺省沿用 confirmText。 */
  busyText?: ReactNode;
  /** 确认按钮图标，busy 时替换为 Spinner。 */
  actionIcon?: ReactNode;
  /** busy 时禁用两个按钮并把确认按钮切换为 Spinner。 */
  busy?: boolean;
  /** 额外禁用两个按钮，不触发 busy 展示。 */
  disabled?: boolean;
  onConfirm: () => void;
};

/**
 * 破坏性确认弹窗的共享骨架：size="sm" + 红色图标 + 取消/确认按钮，
 * busy 时确认按钮显示 Spinner 并切换文案。
 */
function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  icon,
  title,
  description,
  error,
  cancelText = "取消",
  confirmText,
  busyText,
  actionIcon,
  busy = false,
  disabled = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger && <AlertDialogTrigger render={trigger} />}
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">{icon}</AlertDialogMedia>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy || disabled}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant="destructive"
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy ? (
              <>
                <Spinner data-icon="inline-start" aria-hidden />
                {busyText ?? confirmText}
              </>
            ) : (
              <>
                {actionIcon}
                {confirmText}
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { ConfirmDialog };
